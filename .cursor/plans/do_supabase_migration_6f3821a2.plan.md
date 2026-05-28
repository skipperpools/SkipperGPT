---
name: DO Supabase migration
overview: "Migrate SkipperGPT from local SQLite + ngrok to production on a DigitalOcean droplet with Supabase Postgres, persistent volume storage at `/var/skipper`, and GitHub Actions deploy on push to `master`. Includes one required code fix beyond the doc: extend the SQLite migrator for tables added since the plan was written."
todos:
  - id: fix-migrator-tables
    content: Extend TABLE_ORDER in migrate_sqlite_to_postgres.py for job_notes, job_type_task_templates, job_sketches, user_tasks
    status: completed
  - id: unlock-postgres
    content: Remove _local_only_database_url() bypass in database.py; use full URL pipeline
    status: completed
  - id: add-deploy-workflow
    content: Create .github/workflows/deploy.yml for master → SSH deploy on droplet
    status: completed
  - id: supabase-migrate
    content: Create Supabase project; run migrate_sqlite_to_postgres from local PC; verify 13 tables
    status: completed
  - id: provision-droplet
    content: Provision DO droplet + 10GB volume at /var/skipper (Docs, Photos, Sketches)
    status: completed
  - id: droplet-app-setup
    content: Clone repo, venv, production .env, systemd skipper service, nginx site
    status: completed
  - id: dns-https
    content: Point dashboard.skipperpools.net A record to droplet; run Certbot
    status: completed
  - id: github-secrets-deploy
    content: Add DROPLET_IP + DROPLET_SSH_KEY; configure passwordless sudo for systemctl restart
    status: completed
  - id: copy-files-smoke
    content: SCP Docs/Photos/Sketches to volume; smoke-test production URL and auto-deploy
    status: completed
isProject: false
---

# SkipperGPT cloud migration plan

Based on [Docs/migration-plan.md](Docs/migration-plan.md), verified against the current repo. Target domain: **dashboard.skipperpools.net**.

## Target architecture

```mermaid
flowchart LR
  dev[Office PC] -->|git push master| gh[GitHub Actions]
  gh -->|SSH git pull + restart| droplet[DO Droplet]
  browser[Users] -->|HTTPS| nginx[nginx :443]
  nginx --> uvicorn[uvicorn :8000]
  uvicorn --> pg[(Supabase Postgres)]
  uvicorn --> vol["/var/skipper Volume"]
  vol --> docs[Docs/]
  vol --> photos[Photos/]
  vol --> sketches[Sketches/]
```

| Layer | Choice |
|-------|--------|
| App host | DigitalOcean droplet (Ubuntu 22.04, 2 GB / 1 vCPU) |
| Database | Supabase Postgres (`DATABASE_URL` on droplet) |
| Files | DO Block Storage mounted at `/var/skipper` (`DOCS_ROOT=/var/skipper`) |
| Deploy | `.github/workflows/deploy.yml` on push to `master` |
| Public URL | `dashboard.skipperpools.net` (DNS A record → droplet IP) |

**Coexistence note:** [render.yaml](render.yaml) describes an alternate Render deploy path. This migration does not use it; no Render changes required unless you want to remove that file later.

---

## Pre-migration code changes (repo)

### 1. Unlock Postgres in [backend/app/database.py](backend/app/database.py)

The runtime is forced to SQLite via `_local_only_database_url()` (lines 60–79). Replace with the pipeline already documented in comments:

```python
_resolved_url = _strip_pgbouncer_param(
    _normalize_postgres_scheme(
        _resolve_sqlite_path(settings.database_url)
    )
)
```

Delete `_local_only_database_url()` and the “intentionally paused” comment block.

**Local dev stays on SQLite:** [backend/start-backend.ps1](backend/start-backend.ps1) already sets an absolute `DATABASE_URL` to `data/skipper.db` before uvicorn starts, so office dev via `launch.bat` is unaffected after this change.

### 2. Extend [backend/app/migrate_sqlite_to_postgres.py](backend/app/migrate_sqlite_to_postgres.py) `TABLE_ORDER`

The migration doc lists 9 tables; the app now has **13**. Missing tables would be **empty on Supabase** after migration:

| Missing table | FK deps |
|---------------|---------|
| `job_notes` | `jobs`, `users` |
| `job_type_task_templates` | none |
| `job_sketches` | `jobs`, `users` (nullable) |
| `user_tasks` | `users` |

**Proposed order** (parents before children):

```python
TABLE_ORDER = [
    "users",
    "contacts",
    "jobs",
    "job_contacts",
    "job_type_task_templates",
    "job_tasks",
    "job_notes",
    "job_documents",
    "job_photos",
    "job_sketches",
    "feedback_items",
    "user_tasks",
    "notification_items",
]
```

### 3. Add GitHub Actions workflow (new file)

`.github/workflows/` does not exist yet — the workflow is net-new. **Do not copy branch settings from [render.yaml](render.yaml).**

**Branch audit (verified 2026-05-28):**

| Source | Branch | Used for DO deploy? |
|--------|--------|---------------------|
| `git branch --show-current` | `master` | yes |
| `origin/HEAD` | `origin/master` | yes |
| Remote branches | `origin/master` only (no `main`) | yes |
| [render.yaml](render.yaml) line 30 | `main` | **no** — stale; Render blueprint unused on this path |
| [Docs/migration-plan.md](Docs/migration-plan.md) deploy example | `master` | yes — canonical |

Both places in `deploy.yml` must say **`master`** explicitly:

1. **Trigger:** `on.push.branches: [master]` — pushes to `main` will not deploy.
2. **SSH script:** `git pull origin master` — must match the branch cloned on the droplet (`git clone` defaults to the repo’s default branch, which is `master`).

Canonical workflow (copy verbatim; only secrets differ):

```yaml
name: Deploy

on:
  push:
    branches: [master]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: SSH deploy
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.DROPLET_IP }}
          username: skipper
          key: ${{ secrets.DROPLET_SSH_KEY }}
          script: |
            cd /home/skipper/app
            git pull origin master
            cd backend
            .venv/bin/pip install -r requirements.txt --quiet
            sudo systemctl restart skipper
```

**Review checklist when adding the file:** no `branches: [main]`, no `git pull origin main`, no reference to `render.yaml` for branch config.

### 4. Optional housekeeping

- **Procfile** at repo root (documentation only; systemd is the real process manager).
- **render.yaml:** If kept for a possible future Render deploy, change `branch: main` → `branch: master` to avoid confusion (not required for DigitalOcean).
- Update [.env.example](.env.example) with a commented Supabase `DATABASE_URL` example and production `DOCS_ROOT=/var/skipper` (doc currently says examples are omitted).
- **README** still says “SQLite-only runtime” — update after cutover if desired (not blocking).

**Out of scope for code:** droplet provisioning, Supabase project creation, DNS, secrets — all manual/infra steps below.

---

## Phase A — Supabase (dashboard)

1. Create Supabase project (region aligned with droplet, e.g. US-East).
2. Copy **session pooler** URL (port 5432) from Project Settings → Database.
3. Normalize for local migration:
   ```powershell
   $env:DATABASE_URL = "postgresql+psycopg://postgres.xxxx:PASSWORD@HOST:5432/postgres"
   ```
   (`postgresql+psycopg://` prefix ensures SQLAlchemy uses psycopg 3; already handled in migrator via `_normalize_postgres_scheme`.)

---

## Phase B — Data migration (local PC, before live cutover)

**Pre-flight:** Run the app locally once against `data/skipper.db` so [backend/app/main.py](backend/app/main.py) startup migrations (`_ensure_*` columns/tables) are applied to the SQLite file.

```powershell
cd g:\SkipperGPT\backend
.venv\Scripts\Activate.ps1
$env:DATABASE_URL = "postgresql+psycopg://..."   # Supabase URL
python -m app.migrate_sqlite_to_postgres --source ..\data\skipper.db
```

- Script creates schema via `Base.metadata.create_all`, copies rows in FK order, resets sequences.
- Refuses non-empty target unless `--force` (destructive truncate).
- Verify row counts in Supabase Table Editor for all 13 tables, especially `job_sketches`, `job_notes`, `user_tasks`.

**Admin users:** If SQLite already has users, **skip** `create_admin` on the droplet. Only run `python -m app.create_admin` if the migrated DB has zero users.

---

## Phase C — DigitalOcean droplet

### Provision

- Ubuntu 22.04 LTS, 2 GB RAM / 1 vCPU (~$12/mo).
- Attach **10 GB Block Storage** volume; mount at `/var/skipper`.
- SSH key at create time.
- Same region as Supabase when possible.

### Server bootstrap (as root, then `skipper` user)

Per doc: `apt update`, install `python3.11`, `nginx`, `git`; create user `skipper`; format/mount volume; create:

```bash
mkdir -p /var/skipper/Docs /var/skipper/Photos /var/skipper/Sketches
chown -R skipper:skipper /var/skipper
```

**Sketches:** The migration doc only mentions Docs/Photos, but the app stores sketches under `{docs_root}/Sketches/` ([backend/app/services/job_sketches_paths.py](backend/app/services/job_sketches_paths.py)). Include `Sketches/` in volume layout and file copy step.

### App install (as `skipper`)

```bash
git clone https://github.com/skipperpools/SkipperGPT.git /home/skipper/app
cd /home/skipper/app/backend
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
# Optional HEIC: .venv/bin/pip install -r requirements-heic.txt
```

### Production `.env` at `/home/skipper/app/.env`

```ini
APP_ENV=production
DATABASE_URL=postgresql+psycopg://...
DOCS_ROOT=/var/skipper
MAX_UPLOAD_MB=25
SECRET_KEY=<secrets.token_hex(32)>
ACCESS_TOKEN_EXPIRE_MINUTES=10080
CORS_ALLOWED_ORIGINS=
```

Generate secret: `python -c "import secrets; print(secrets.token_hex(32))"`.

`Schedules.xlsx` is only needed for seeding ([backend/app/seed.py](backend/app/seed.py)), not normal runtime after DB migration.

---

## Phase D — Process manager and reverse proxy

### systemd — `/etc/systemd/system/skipper.service`

- User: `skipper`
- `WorkingDirectory=/home/skipper/app/backend`
- `EnvironmentFile=/home/skipper/app/.env`
- `ExecStart=.../uvicorn app.main:app --host 127.0.0.1 --port 8000`
- `Restart=always`

Enable and start; confirm `GET http://127.0.0.1:8000/api/health` on the droplet.

### nginx — `/etc/nginx/sites-available/skipper`

```nginx
server_name dashboard.skipperpools.net;
client_max_body_size 30M;
proxy_pass http://127.0.0.1:8000;
# standard proxy headers + proxy_read_timeout 120s
```

### DNS + HTTPS

1. **DNS:** A record `dashboard.skipperpools.net` → droplet public IP (TTL low during cutover).
2. **Certbot** after DNS propagates:
   ```bash
   apt install -y certbot python3-certbot-nginx
   certbot --nginx -d dashboard.skipperpools.net
   ```

### Sudo for deploy user

`/etc/sudoers.d/skipper-deploy`:

```
skipper ALL=(ALL) NOPASSWD: /bin/systemctl restart skipper
```

---

## Phase E — GitHub Actions auto-deploy

1. Generate deploy key locally: `ssh-keygen -t ed25519 -f ~/.ssh/skipper_deploy -N ""`
2. Append `skipper_deploy.pub` to `/home/skipper/.ssh/authorized_keys` on droplet.
3. GitHub repo secrets:
   - `DROPLET_IP`
   - `DROPLET_SSH_KEY` (private key contents)
4. Commit and push `deploy.yml` + code changes to `master`.
5. Test: trivial commit → workflow runs → `git pull` + `pip install` + `systemctl restart skipper`.

---

## Phase F — File assets (office PC → volume)

Copy from project root (adjust source paths to your machine):

```powershell
scp -r G:\SkipperGPT\Docs skipper@DROPLET_IP:/var/skipper/
scp -r G:\SkipperGPT\Photos skipper@DROPLET_IP:/var/skipper/
scp -r G:\SkipperGPT\Sketches skipper@DROPLET_IP:/var/skipper/
```

Or `rsync -avz` if available. Fix ownership on droplet if needed: `chown -R skipper:skipper /var/skipper`.

---

## Execution order (recommended)

| # | Step | Where |
|---|------|-------|
| 1 | Code: fix `TABLE_ORDER`, unlock Postgres, add `deploy.yml` | Local → commit |
| 2 | Create Supabase project, save `DATABASE_URL` | Supabase |
| 3 | Run migrator against empty Supabase | Local PC |
| 4 | Verify all 13 tables in Supabase | Supabase UI |
| 5 | Provision droplet + volume + bootstrap | DigitalOcean |
| 6 | Clone repo, `.env`, pip install | Droplet |
| 7 | systemd + nginx (HTTP first) | Droplet |
| 8 | DNS A record for `dashboard.skipperpools.net` | DNS provider |
| 9 | Certbot HTTPS | Droplet |
| 10 | GitHub secrets + push to test deploy | GitHub |
| 11 | SCP Docs/Photos/Sketches | Office PC |
| 12 | Smoke test: login, jobs, uploads, thumbnails | Browser |
| 13 | Turn off ngrok; keep `launch.bat` for local-only dev if needed | Office PC |

**Cutover:** Point production users at `https://dashboard.skipperpools.net` only after steps 1–11 succeed. Pushing Postgres unlock (step 1) to `master` before the droplet has `.env` does not affect the office PC if deploy runs before droplet is ready — but avoid pointing office `.env` at Supabase until intentional.

---

## Risks and gotchas

| Topic | Detail |
|-------|--------|
| **No Alembic** | Schema comes from `Base.metadata.create_all` on startup. New models later need manual migration strategy (doc notes this). |
| **SQLite `_ensure_*` on Postgres** | Startup still runs column guards in [main.py](backend/app/main.py); they no-op or ALTER only when needed — safe but not a substitute for Alembic long-term. |
| **JWT secret** | Production `SECRET_KEY` must be stable; changing it invalidates all sessions. |
| **Branch** | Repo default is `master` only. `deploy.yml` must use `branches: [master]` and `git pull origin master`. `render.yaml`’s `branch: main` is stale and does not affect Actions or the droplet. |
| **pgbouncer / SSL** | `_strip_pgbouncer_param()` already in pipeline; add `?sslmode=require` only if SSL errors appear. |
| **Empty migrator tables** | Must fix `TABLE_ORDER` before first migration — cannot easily “append” missed tables without `--force` re-import. |

---

## Verification checklist

- [ ] Supabase: row counts match SQLite for users, jobs, tasks, documents, photos, sketches, notifications
- [ ] `https://dashboard.skipperpools.net/api/health` returns OK
- [ ] Login with existing migrated user
- [ ] Open job with PDFs/photos/sketches — files resolve under `/var/skipper`
- [ ] Upload test (≤ `MAX_UPLOAD_MB`)
- [ ] `git push` to `master` triggers deploy and app restarts cleanly
- [ ] Local `launch.bat` still uses SQLite on port 8001 (unchanged dev path)
