"""Export/import backup bundle for Skipper local data.

Run from `backend/`:
    python -m app.backup_bundle export
    python -m app.backup_bundle import "..\\backups\\skipper-backup-YYYYMMDD-HHMMSS.zip"
"""
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from .config import PROJECT_ROOT, settings

BUNDLE_VERSION = 1
MANIFEST_NAME = "manifest.json"
DB_ARCHIVE_PATH = "database/skipper.db"
DOCS_ARCHIVE_DIR = "files/Docs/"
PHOTOS_ARCHIVE_DIR = "files/Photos/"
USERS_MANIFEST_PATH = "exports/users_manifest.json"


@dataclass(frozen=True)
class LocalPaths:
    project_root: Path
    docs_root: Path
    docs_dir: Path
    photos_dir: Path
    sqlite_db: Path


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def _resolve_sqlite_db_path() -> Path:
    db_url = settings.database_url.strip()
    prefix = "sqlite:///"
    raw_path = db_url[len(prefix):] if db_url.startswith(prefix) else "./data/skipper.db"
    is_posix_abs = raw_path.startswith("/")
    is_win_abs = len(raw_path) >= 2 and raw_path[1] == ":"
    if is_posix_abs or is_win_abs:
        db_path = Path(raw_path)
    else:
        db_path = PROJECT_ROOT / raw_path
    return db_path.resolve()


def _local_paths() -> LocalPaths:
    docs_root = settings.docs_root.resolve()
    return LocalPaths(
        project_root=PROJECT_ROOT.resolve(),
        docs_root=docs_root,
        docs_dir=(docs_root / "Docs").resolve(),
        photos_dir=(docs_root / "Photos").resolve(),
        sqlite_db=_resolve_sqlite_db_path(),
    )


def _users_manifest_data(db_path: Path) -> tuple[int, list[dict]]:
    """Read non-sensitive user rows for inclusion in backup (hashes stay in DB file only)."""
    if not db_path.is_file():
        return 0, []
    try:
        uri = db_path.resolve().as_uri()
        conn = sqlite3.connect(f"{uri}?mode=ro", uri=True)
    except sqlite3.Error:
        return 0, []
    try:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'"
        ).fetchone()
        if row is None:
            return 0, []
        cur = conn.execute(
            "SELECT id, username, role, is_active, created_at FROM users ORDER BY id"
        )
        users: list[dict] = []
        for uid, username, role, is_active, created_at in cur.fetchall():
            users.append({
                "id": uid,
                "username": username,
                "role": role,
                "is_active": bool(is_active),
                "created_at": created_at,
            })
        return len(users), users
    except sqlite3.Error:
        return 0, []
    finally:
        conn.close()


def _write_tree_to_zip(zip_file: ZipFile, source_root: Path, archive_root: str) -> int:
    file_count = 0
    zip_file.writestr(archive_root, b"")
    if not source_root.exists():
        return file_count
    for file_path in source_root.rglob("*"):
        if file_path.is_file():
            rel_path = file_path.relative_to(source_root).as_posix()
            zip_file.write(file_path, f"{archive_root}{rel_path}")
            file_count += 1
    return file_count


def _build_manifest(
    paths: LocalPaths,
    *,
    db_present: bool,
    docs_files: int,
    photos_files: int,
    user_count: int,
) -> dict:
    return {
        "bundle_version": BUNDLE_VERSION,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": {
            "project_root": str(paths.project_root),
            "docs_root": str(paths.docs_root),
            "database_path": str(paths.sqlite_db),
        },
        "included": {
            "database": db_present,
            "user_count": user_count,
            "docs_dir_exists": paths.docs_dir.exists(),
            "photos_dir_exists": paths.photos_dir.exists(),
            "docs_file_count": docs_files,
            "photos_file_count": photos_files,
            "users_manifest_file": db_present,
        },
    }


def export_bundle(output_path: Path | None = None) -> Path:
    paths = _local_paths()
    if output_path is None:
        output_path = paths.project_root / "backups" / f"skipper-backup-{_timestamp()}.zip"
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    db_present = paths.sqlite_db.exists()
    user_count, user_rows = _users_manifest_data(paths.sqlite_db)
    docs_files = 0
    photos_files = 0

    with ZipFile(output_path, mode="w", compression=ZIP_DEFLATED) as bundle:
        docs_files = _write_tree_to_zip(bundle, paths.docs_dir, DOCS_ARCHIVE_DIR)
        photos_files = _write_tree_to_zip(bundle, paths.photos_dir, PHOTOS_ARCHIVE_DIR)
        if db_present:
            bundle.write(paths.sqlite_db, DB_ARCHIVE_PATH)
            users_manifest = {
                "user_count": user_count,
                "users": user_rows,
                "note": (
                    "Password hashes and full auth state live only in database/skipper.db; "
                    "restore that file to preserve logins."
                ),
            }
            bundle.writestr(USERS_MANIFEST_PATH, json.dumps(users_manifest, indent=2))

        manifest = _build_manifest(
            paths,
            db_present=db_present,
            docs_files=docs_files,
            photos_files=photos_files,
            user_count=user_count,
        )
        bundle.writestr(MANIFEST_NAME, json.dumps(manifest, indent=2))

    print(f"[backup] Export complete: {output_path}")
    print(f"[backup] DB included: {db_present} ({paths.sqlite_db})")
    print(f"[backup] Users backed up (in DB + manifest): {user_count}")
    print(f"[backup] Docs files: {docs_files} ({paths.docs_dir})")
    print(f"[backup] Photos files: {photos_files} ({paths.photos_dir})")
    return output_path


def _require_archive_entry(names: set[str], required: str) -> None:
    if required not in names:
        raise ValueError(f"Archive is missing required entry: {required}")


def _require_archive_prefix(names: set[str], required_prefix: str) -> None:
    if not any(name == required_prefix or name.startswith(required_prefix) for name in names):
        raise ValueError(f"Archive is missing required path: {required_prefix}")


def _pre_import_backup(paths: LocalPaths) -> Path:
    backup_path = paths.project_root / "backups" / f"pre-import-{_timestamp()}.zip"
    return export_bundle(backup_path)


def _restore_tree(extracted_root: Path, extracted_rel: str, target_dir: Path) -> None:
    extracted_dir = extracted_root / extracted_rel
    if not extracted_dir.exists():
        raise ValueError(f"Extracted content missing: {extracted_dir}")
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(extracted_dir, target_dir)


def import_bundle(archive_path: Path, *, pre_backup: bool = True) -> None:
    archive_path = archive_path.resolve()
    if not archive_path.is_file():
        raise FileNotFoundError(f"Archive not found: {archive_path}")

    paths = _local_paths()
    with ZipFile(archive_path, mode="r") as bundle:
        names = set(bundle.namelist())
        _require_archive_entry(names, MANIFEST_NAME)
        _require_archive_entry(names, DB_ARCHIVE_PATH)
        _require_archive_prefix(names, DOCS_ARCHIVE_DIR)
        _require_archive_prefix(names, PHOTOS_ARCHIVE_DIR)
        try:
            manifest = json.loads(bundle.read(MANIFEST_NAME).decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid manifest.json: {exc}") from exc
        bundle_version = int(manifest.get("bundle_version", -1))
        if bundle_version != BUNDLE_VERSION:
            raise ValueError(
                f"Unsupported bundle version: {bundle_version} (expected {BUNDLE_VERSION})"
            )

    if pre_backup:
        backup_path = _pre_import_backup(paths)
        print(f"[backup] Current state backed up before import: {backup_path}")

    with tempfile.TemporaryDirectory(prefix="skipper-import-") as tmp:
        tmp_root = Path(tmp).resolve()
        with ZipFile(archive_path, mode="r") as bundle:
            bundle.extractall(tmp_root)

        extracted_db = tmp_root / DB_ARCHIVE_PATH
        if not extracted_db.is_file():
            raise ValueError(f"Extracted DB missing: {extracted_db}")

        paths.sqlite_db.parent.mkdir(parents=True, exist_ok=True)
        db_tmp = paths.sqlite_db.with_suffix(paths.sqlite_db.suffix + ".importing")
        shutil.copy2(extracted_db, db_tmp)
        try:
            db_tmp.replace(paths.sqlite_db)
        except PermissionError as exc:
            if db_tmp.exists():
                db_tmp.unlink(missing_ok=True)
            raise PermissionError(
                "Could not replace local database file. "
                "Stop the backend (or any process using skipper.db) and retry import."
            ) from exc

        _restore_tree(tmp_root, DOCS_ARCHIVE_DIR.rstrip("/"), paths.docs_dir)
        _restore_tree(tmp_root, PHOTOS_ARCHIVE_DIR.rstrip("/"), paths.photos_dir)

    user_after, _ = _users_manifest_data(paths.sqlite_db)
    print(f"[backup] Import complete from: {archive_path}")
    print(f"[backup] Restored DB: {paths.sqlite_db}")
    print(f"[backup] Restored Docs: {paths.docs_dir}")
    print(f"[backup] Restored Photos: {paths.photos_dir}")
    print(f"[backup] Users in restored database: {user_after}")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Export/import a Skipper backup bundle "
            "(SQLite DB including users/jobs/metadata, Docs, Photos)."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    export_cmd = sub.add_parser("export", help="Create backup archive.")
    export_cmd.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output zip path. Default: <project>/backups/skipper-backup-<timestamp>.zip",
    )

    import_cmd = sub.add_parser("import", help="Restore backup archive.")
    import_cmd.add_argument("archive", type=Path, help="Path to backup zip to import.")
    import_cmd.add_argument(
        "--skip-pre-backup",
        action="store_true",
        help="Do not create a safety pre-import backup zip before restoring.",
    )

    return parser


def main() -> None:
    args = _build_parser().parse_args()
    if args.command == "export":
        export_bundle(args.output)
        return
    if args.command == "import":
        import_bundle(args.archive, pre_backup=not args.skip_pre_backup)
        return
    raise ValueError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    main()
