"""Create the first admin user when the database has no users.

Usage (from `backend/`):

    python -m app.create_admin USERNAME PASSWORD
"""
from __future__ import annotations

import argparse
import logging
import sys
import traceback

from .database import Base, SessionLocal, engine
from .models import User  # noqa: F401
from .repositories import users_repo

logger = logging.getLogger("skipper.create_admin")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Create initial admin if no users exist.")
    parser.add_argument("username")
    parser.add_argument("password")
    args = parser.parse_args()
    args.username = args.username.strip()
    args.password = args.password.strip()

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if users_repo.ensure_first_admin(db, args.username, args.password):
            logger.info("Created admin user %r.", args.username)
        else:
            logger.info(
                "Skipped: database already has users. Use the admin UI or DELETE users first.",
            )
    finally:
        db.close()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
    sys.exit(0)
