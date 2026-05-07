"""Password hashing (bcrypt) and JWT helpers (HS256).

Uses the ``bcrypt`` package directly (not passlib) so hashing works reliably with
current bcrypt releases; passlib's bcrypt backend is unmaintained and breaks on
newer bcrypt (e.g. missing ``__about__``).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
from jose import jwt

from .config import settings

# bcrypt only accepts at most this many UTF-8 bytes.
BCRYPT_MAX_PASSWORD_BYTES = 72
_BCRYPT_ROUNDS = 12


def password_utf8_byte_len(password: str) -> int:
    return len(password.encode("utf-8"))


def assert_password_within_bcrypt_limit(password: str) -> None:
    n = password_utf8_byte_len(password)
    if n > BCRYPT_MAX_PASSWORD_BYTES:
        raise ValueError(
            f"Password is too long for bcrypt ({n} UTF-8 bytes; maximum is "
            f"{BCRYPT_MAX_PASSWORD_BYTES}). Use a shorter password."
        )


def verify_password(plain: str, hashed: str) -> bool:
    if password_utf8_byte_len(plain) > BCRYPT_MAX_PASSWORD_BYTES:
        return False
    try:
        return bcrypt.checkpw(
            plain.encode("utf-8"),
            hashed.encode("ascii"),
        )
    except (ValueError, TypeError):
        return False


def get_password_hash(password: str) -> str:
    assert_password_within_bcrypt_limit(password)
    digest = bcrypt.hashpw(
        password.encode("utf-8"),
        bcrypt.gensalt(rounds=_BCRYPT_ROUNDS),
    )
    return digest.decode("ascii")


def create_access_token(data: dict[str, Any]) -> str:
    to_encode = dict(data)
    expire = datetime.now(timezone.utc) + timedelta(
        minutes=settings.access_token_expire_minutes
    )
    to_encode["exp"] = int(expire.timestamp())
    return jwt.encode(to_encode, settings.secret_key, algorithm="HS256")


def decode_token(token: str) -> dict[str, Any]:
    return jwt.decode(token, settings.secret_key, algorithms=["HS256"])
