from collections.abc import Iterable

from fastapi import HTTPException, Depends, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.auth.jwt_handler import decode_token

bearer_scheme = HTTPBearer(auto_error=False)


def satisfies(held: Iterable[str], required: str) -> bool:
    """Does this permission set satisfy `required`?

    `<verb>:all` is a wildcard over its own verb: a holder of `read:all` holds
    every `read:*`, and `export:all` every `export:*`. Verbs never cross — reading
    everything is not permission to write anything.

    This has always been the product's meaning (the page-permission map lists
    `read:all` as an alternative to every specific read permission), but it used
    to be re-implemented as a literal `in` test at each gate. A supply director
    holding `read:all` was therefore admitted to the Transport module and then
    told, on the action inside it, that they lacked `read:field` — the same user
    accepted by one check and turned away by the next. One helper, used by every
    gate, is what stops those two answers from drifting apart.
    """
    perms = set(held)
    if required in perms:
        return True
    verb, _, scope = required.partition(":")
    return bool(scope) and f"{verb}:all" in perms


def satisfies_any(held: Iterable[str], required: Iterable[str]) -> bool:
    perms = set(held)
    return any(satisfies(perms, r) for r in required)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    payload = decode_token(credentials.credentials)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    return payload


def require_permission(permission: str):
    async def checker(user: dict = Depends(get_current_user)):
        if not satisfies(user.get("permissions", []), permission):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
        return user
    return checker


def require_any_permission(*permissions: str):
    """Pass if the authenticated user holds ANY of the listed permissions."""
    async def checker(user: dict = Depends(get_current_user)):
        if not satisfies_any(user.get("permissions", []), permissions):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires one of: {', '.join(permissions)}",
            )
        return user
    return checker


async def optional_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict | None:
    if not credentials:
        return None
    payload = decode_token(credentials.credentials)
    return payload if payload else None
