# DigitalOcean + Supabase deployment

Runbook for **dashboard.skipperpools.net**. Repo code changes (Postgres unlock, migrator, GitHub Actions) are on `master`.

## 1. Supabase

1. Create a project (region near your droplet).
2. Copy the **session pooler** URL (port 5432) from Project Settings → Database.
3. On your office PC, from project root:

   ```powershell
   $env:DATABASE_URL = "postgresql+psycopg://postgres.xxxx:PASSWORD@HOST:5432/postgres"
   .\scripts\migrate-to-supabase.ps1
   ```

   Or add `DATABASE_URL` to `.env` and run `.\scripts\migrate-to-supabase.ps1`.

4. Verify all **13 tables** in the Supabase Table Editor.

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
