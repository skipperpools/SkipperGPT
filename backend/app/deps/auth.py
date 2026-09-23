"""FastAPI dependencies for JWT bearer auth and role checks."""

from __future__ import annotations



from fastapi import Depends, HTTPException, Request, status

from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from jose import JWTError
from sqlalchemy import select

from sqlalchemy.orm import Session



from ..auth_utils import decode_token

from ..database import get_db

from ..constants import ROLE_JOB_TYPES, VALID_JOB_TYPES
from ..models import Job, User, UserJobTypeGrant



security = HTTPBearer()





def get_current_user(

    creds: HTTPAuthorizationCredentials = Depends(security),

    db: Session = Depends(get_db),

) -> User:

    try:

        payload = decode_token(creds.credentials)

    except JWTError:

        raise HTTPException(

            status_code=status.HTTP_401_UNAUTHORIZED,

            detail="Could not validate credentials",

            headers={"WWW-Authenticate": "Bearer"},

        )

    sub = payload.get("sub")

    if sub is None:

        raise HTTPException(

            status_code=status.HTTP_401_UNAUTHORIZED,

            detail="Could not validate credentials",

            headers={"WWW-Authenticate": "Bearer"},

        )

    try:

        user_id = int(sub)

    except (TypeError, ValueError):

        raise HTTPException(

            status_code=status.HTTP_401_UNAUTHORIZED,

            detail="Could not validate credentials",

            headers={"WWW-Authenticate": "Bearer"},

        )

    user = db.get(User, user_id)

    if user is None or not user.is_active:

        raise HTTPException(

            status_code=status.HTTP_401_UNAUTHORIZED,

            detail="Could not validate credentials",

            headers={"WWW-Authenticate": "Bearer"},

        )

    return user





def require_roles(*allowed: str):

    allowed_set = frozenset(allowed)



    def _dep(user: User = Depends(get_current_user)) -> User:

        if user.role not in allowed_set:

            raise HTTPException(

                status_code=status.HTTP_403_FORBIDDEN,

                detail="Insufficient permissions",

            )

        return user



    return _dep



def allowed_job_types_for(db: Session, user: User) -> frozenset[str]:
    """Role defaults + admin grants, read straight from the DB so it works
    for any User instance (session-bound or not)."""
    allowed = set(ROLE_JOB_TYPES.get(user.role, frozenset()))
    if user.id is not None:
        allowed.update(
            db.execute(
                select(UserJobTypeGrant.job_type).where(UserJobTypeGrant.user_id == user.id)
            ).scalars()
        )
    return frozenset(allowed & VALID_JOB_TYPES)


def enforce_job_type_access(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Router-level guard: any route with a {job_id} path param 404s when the
    job's type isn't in the user's allowed_job_types (role defaults + admin
    grants). 404 rather than 403 so hidden jobs don't reveal they exist.
    Routes without {job_id} pass straight through."""
    raw = request.path_params.get("job_id")
    if raw is None:
        return
    try:
        job_id = int(raw)
    except (TypeError, ValueError):
        return
    job_type = db.execute(select(Job.job_type).where(Job.id == job_id)).scalar_one_or_none()
    if job_type is None:
        return  # let the route produce its own 404
    if job_type not in allowed_job_types_for(db, user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
