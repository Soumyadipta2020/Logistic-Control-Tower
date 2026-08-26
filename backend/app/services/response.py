from datetime import datetime, timezone
from typing import Any
from app.config import get_settings

settings = get_settings()


def ok(data: Any, meta: dict | None = None) -> dict:
    return {
        "success": True,
        "data": data,
        "meta": {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "source": "synthetic" if settings.demo_mode else "live",
            **(meta or {}),
        },
        "errors": [],
    }


def err(message: str, code: str = "ERROR") -> dict:
    return {
        "success": False,
        "data": None,
        "meta": {"timestamp": datetime.now(timezone.utc).isoformat()},
        "errors": [{"code": code, "message": message}],
    }
