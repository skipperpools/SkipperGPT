# DigitalOcean deployment

Runbook for **dashboard.skipperpools.net** — this is the live production setup, not a future plan. The droplet, nginx, systemd service, and GitHub Actions deploy were stood up first, running on SQLite; the database was later cut over to a DigitalOcean Managed PostgreSQL cluster (NYC1, same region/VPC as the droplet). Earlier versions of this runbook referenced Supabase as the Postgres host — DigitalOcean's own Managed Database is what's actually in use now, since it keeps everything under one provider and supports a private VPC connection to the droplet.

## 1. Database (DigitalOcean Managed PostgreSQL)

1. In the DigitalOcean console, create a Database Cluster → PostgreSQL, same region as the droplet (NYC1). The 1 GiB/1 vCPU single-node plan (~$15/mo) is sufficient for this app's scale.
2. Under **Connection Details**, switch to the **VPC network** tab (private, same-VPC connection — lower latency and never exposed publicly) and copy the connection string. Use the **Public network** tab only for one-off access from outside the VPC (e.g. running the migration from a non-droplet machine).
3. On the droplet (or wherever the source SQLite file currently lives), run the migration:

   ```bash
   sudo systemctl stop skipper   # avoid writes racing the copy
   cd /home/skipper/app/backend
   export DATABASE_URL="postgresql+psycopg://doadmin:PASSWORD@<vpc-host>:25060/defaultdb?sslmode=require"
   .venv/bin/python -m app.migrate_sqlite_to_postgres --source ../data/skipper.db
   ```

4. Verify all **13 tables** in the DigitalOcean console's database dashboard.
5. Update `/home/skipper/app/.env` with the same `DATABASE_URL`, then `sudo systemctl start skipper`.

`scripts/migrate-to-supabase.ps1` still works the same way against any Postgres `DATABASE_URL` (the migration script itself is host-agnostic) if you ever need to run the copy from a Windows machine instead of the droplet.

## 2. Droplet bootstrap

1. Create Ubuntu 22.04 droplet (2 GB RAM), attach 10 GB volume, add SSH key.
2. SSH as root and run (replace volume id):

   ```bash
   curl -sL https://raw.githubusercontent.com/skipperpools/SkipperGPT/master/deploy/bootstrap-droplet.sh -o /tmp/bootstrap.sh
   bash /tmp/bootstrap.sh /dev/disk/by-id/YOUR-VOLUME-ID
   ```

   Or clone the repo and run `deploy/bootstrap-droplet.sh` from a checkout.

3. Create `/home/skipper/app/.env` from [production.env.example](production.env.example). Generate `SECRET_KEY`:

   ```bash
   python3 -c "import secrets; print(secrets.token_hex(32))"
   ```

4. Install systemd + nginx + sudoers:

   ```bash
   cp deploy/skipper.service /etc/systemd/system/skipper.service
   cp deploy/nginx-skipper.conf /etc/nginx/sites-available/skipper
   ln -sf /etc/nginx/sites-available/skipper /etc/nginx/sites-enabled/
   cp deploy/sudoers-skipper-deploy /etc/sudoers.d/skipper-deploy
   chmod 440 /etc/sudoers.d/skipper-deploy
   nginx -t && systemctl reload nginx
   systemctl daemon-reload && systemctl enable --now skipper
   ```

5. If the DB has no users after migration:  
   `su - skipper -c "cd /home/skipper/app/backend && .venv/bin/python -m app.create_admin USER PASS"`

## 3. DNS and HTTPS

1. Add DNS **A** record: `dashboard.skipperpools.net` → droplet public IP.
2. After propagation:

   ```bash
   apt install -y certbot python3-certbot-nginx
   certbot --nginx -d dashboard.skipperpools.net
   ```

## 4. GitHub Actions deploy

1. On your PC: `ssh-keygen -t ed25519 -f ~/.ssh/skipper_deploy -N ""`
2. Append `skipper_deploy.pub` to `/home/skipper/.ssh/authorized_keys` on the droplet.
3. In GitHub → Settings → Secrets → Actions, add:
   - `DROPLET_IP` — droplet public IP
   - `DROPLET_SSH_KEY` — contents of `skipper_deploy` (private key)
4. Push to `master`; confirm the **Deploy** workflow succeeds.

## 5. Copy files

From project root on Windows:

```powershell
.\scripts\copy-files-to-droplet.ps1 -DropletHost skipper@YOUR_DROPLET_IP
```

## 6. Smoke test

- `https://dashboard.skipperpools.net/api/health`
- Login, open a job with attachments, test upload
- `git push` to `master` and confirm auto-deploy restarts the service
