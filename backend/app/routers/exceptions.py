import asyncio
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, Query
from pydantic import BaseModel
from app.services.response import ok
from app.services.websocket_manager import ws_manager
from app.synthetic.state import synthetic_state
from app.synthetic.cadence import TICK_INTERVAL_S
from app.auth.rbac import get_current_user, require_any_permission

router = APIRouter(prefix="/api/v1/exceptions", tags=["exceptions"])


async def _broadcast_status_change(result: dict):
    """Broadcast the updated exception, and — if it's a P1 — immediately push
    a fresh open-P1 list too. Without this, a P1 that just got acknowledged
    keeps showing in the AppShell banner until the next scheduled tick
    (up to ~60-120s later), since the banner only clears on p1_active."""
    await ws_manager.broadcast("exceptions", "status_change", result)
    if result.get("priority") == "P1":
        state = synthetic_state.get_snapshot()
        open_p1 = [e for e in state.get("exceptions", []) if e.get("priority") == "P1" and e.get("status") == "open"]
        await ws_manager.broadcast("exceptions", "p1_active", open_p1)


@router.get("")
async def list_exceptions(
    priority: str | None = Query(None),
    status: str | None = Query(None),
    page: int = Query(1, ge=1),
    _: dict = Depends(get_current_user),
):
    state = synthetic_state.get_snapshot()
    exceptions = state.get("exceptions", [])
    if priority:
        exceptions = [e for e in exceptions if e.get("priority") == priority]
    if status:
        exceptions = [e for e in exceptions if e.get("status") == status]
    per_page = 25
    start = (page - 1) * per_page
    return ok({"items": exceptions[start:start + per_page], "total": len(exceptions), "page": page})


# /alert-rules MUST be before /{exception_code} — FastAPI matches in definition order
@router.get("/alert-rules")
async def get_alert_rules(_: dict = Depends(get_current_user)):
    state = synthetic_state.get_snapshot()
    return ok(state.get("alert_rules", []))


class AlertRuleUpdate(BaseModel):
    is_active: bool | None = None
    condition_override: dict | None = None
    notification_channels: dict | None = None


@router.put("/alert-rules/{rule_code}")
async def update_alert_rule(rule_code: str, req: AlertRuleUpdate, _: dict = Depends(require_any_permission("write:exception"))):
    result = synthetic_state.update_alert_rule(rule_code, req.dict(exclude_none=True))
    return ok(result)


@router.get("/{exception_code}")
async def get_exception(exception_code: str, _: dict = Depends(get_current_user)):
    state = synthetic_state.get_snapshot()
    exc = next((e for e in state.get("exceptions", []) if e.get("exception_code") == exception_code), None)
    return ok(exc)


class AcknowledgeRequest(BaseModel):
    acknowledged_by: str
    notes: str | None = None


@router.post("/{exception_code}/acknowledge")
async def acknowledge_exception(exception_code: str, req: AcknowledgeRequest, _: dict = Depends(require_any_permission("write:exception"))):
    result = synthetic_state.acknowledge_exception(exception_code, req.acknowledged_by, req.notes)
    await _broadcast_status_change(result)
    return ok(result)


class ActivatePlanRequest(BaseModel):
    activated_by: str


@router.post("/{exception_code}/activate-plan")
async def activate_risk_plan(exception_code: str, req: ActivatePlanRequest, _: dict = Depends(require_any_permission("write:exception"))):
    result = synthetic_state.activate_risk_plan(exception_code, req.activated_by)
    await _broadcast_status_change(result)
    # Plan compensation mutates warehouse_status (e.g. partial throughput
    # recovery) as well as the exception — push it like apply_scenario does
    # so any tab open on the Visibility Hub updates immediately too.
    snapshot = synthetic_state.get_snapshot()
    await ws_manager.broadcast("visibility", "throughput", snapshot.get("warehouse_status", []))
    return ok(result)


class ResolveRequest(BaseModel):
    resolved_by: str
    root_cause: str
    resolution_notes: str | None = None


@router.post("/{exception_code}/resolve")
async def resolve_exception(exception_code: str, req: ResolveRequest, _: dict = Depends(require_any_permission("write:exception"))):
    result = synthetic_state.resolve_exception(exception_code, req.resolved_by, req.root_cause, req.resolution_notes)
    await _broadcast_status_change(result)
    return ok(result)


def open_exception_counts(state: dict) -> dict:
    """Shape of the `exceptions_tick` payload. Lives here next to the channel it
    describes; `main.py`'s scheduled producer imports it."""
    open_exceptions = [e for e in state.get("exceptions", []) if e.get("status") == "open"]
    return {
        "open_count": len(open_exceptions),
        "p1_count": len([e for e in open_exceptions if e.get("priority") == "P1"]),
    }


@router.websocket("/ws/exceptions")
async def websocket_exceptions(websocket: WebSocket):
    await ws_manager.connect(websocket, "exceptions")
    # Prime THIS client only, then listen — the same correction already applied
    # to /ws/visibility (see the note there).
    #
    # This handler used to run its own loop that re-broadcast to the WHOLE
    # channel every 30s, once per open connection: N clients produced N×N
    # messages and each client received N copies. It also made `p1_active` a
    # two-producer event, and the two disagreed — the scheduler in main.py
    # always broadcasts (including an empty list, which is how a client learns
    # a P1 cleared), while this loop only broadcast when the list was non-empty.
    # A cleared banner could therefore be resurrected by whichever arrived last.
    # The scheduler is the single producer; this socket now only listens.
    state = synthetic_state.get_snapshot()
    await ws_manager.send(websocket, "exceptions_tick", open_exception_counts(state))
    await ws_manager.send(websocket, "p1_active",
                          [e for e in state.get("exceptions", [])
                           if e.get("priority") == "P1" and e.get("status") == "open"])
    try:
        while True:
            await asyncio.sleep(TICK_INTERVAL_S)
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket, "exceptions")
