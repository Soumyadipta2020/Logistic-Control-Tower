from datetime import datetime, timedelta, timezone
from typing import Any
from jose import JWTError, jwt
from passlib.context import CryptContext
from app.config import get_settings

settings = get_settings()
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

ALGORITHM = "HS256"

# `<verb>:all` is a wildcard over its own verb — see `satisfies()` in app.auth.rbac.
# Verbs never cross: read:all grants no writes.
#
# Seniority has to imply the lesser privilege. This list previously gave the
# Supply Chain Director authority to commit a £1.6m emergency purchase order
# while refusing them a £7 van-to-van stock move — and refused the Supply Chain
# *Director* the right to add a supplier to the OTIF watch-list. Relocating stock
# the business already owns is strictly less consequential than committing new
# spend, so a role that may do the second must be able to do the first, or the
# model is not an authority model at all.
DEMO_USERS = {
    "supply.director@centrica.com": {
        "password": "demo1234",
        "role": "supply_chain_director",
        "name": "Sarah Chen",
        # Top of the operational chain: may authorise any write, and new write
        # permissions are covered as they are added rather than silently missing.
        "permissions": ["read:all", "write:all", "export:all"],
    },
    "logistics.ops@centrica.com": {
        "password": "demo1234",
        "role": "logistics_ops",
        "name": "James Okafor",
        # Locker failover and catch-up drops are core logistics-ops work; they
        # were the same gap one rung down.
        "permissions": ["read:all", "write:po", "write:exception", "write:transfer", "write:locker"],
    },
    "field.dispatcher@centrica.com": {
        "password": "demo1234",
        "role": "field_dispatcher",
        "name": "Maria Santos",
        "permissions": ["read:field", "write:transfer", "write:locker"],
    },
    "finance.analyst@centrica.com": {
        "password": "demo1234",
        "role": "finance_analyst",
        "name": "David Williams",
        "permissions": ["read:finance", "read:analytics", "export:finance"],
    },
    "engineer@centrica.com": {
        "password": "demo1234",
        "role": "engineer",
        "name": "Tom Briggs",
        "permissions": ["read:own_jobs", "read:own_van_stock", "write:job_completion"],
    },
    "sustainability@centrica.com": {
        "password": "demo1234",
        "role": "sustainability_manager",
        "name": "Emma Clarke",
        "permissions": ["read:sustainability", "read:reverse", "export:sustainability"],
    },
    "procurement@centrica.com": {
        "password": "demo1234",
        "role": "procurement_manager",
        "name": "Raj Patel",
        "permissions": ["read:suppliers", "write:po", "write:supplier_review"],
    },
}


def create_access_token(data: dict[str, Any]) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.secret_key, algorithm=ALGORITHM)


def decode_token(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except JWTError:
        return {}


def authenticate_user(email: str, password: str) -> dict | None:
    user = DEMO_USERS.get(email)
    if not user or user["password"] != password:
        return None
    return {"email": email, **user}
