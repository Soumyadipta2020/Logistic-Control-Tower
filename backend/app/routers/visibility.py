import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, Query
from pydantic import BaseModel
from app.services.websocket_manager import ws_manager
from app.services.response import ok
from app.synthetic.state import synthetic_state
from app.synthetic.cadence import TICK_INTERVAL_S
from app.auth.rbac import get_current_user, require_any_permission

router = APIRouter(prefix="/api/v1/visibility", tags=["visibility"])

# Resolving an alert changes operational state (stock moves, a job is
# reallocated, a route gains a stop, an order is placed downstream), so it needs
# a write permission — the same set the transport actions already use.
_WRITE = require_any_permission("write:exception", "write:transfer", "write:playbook", "write:locker")


@router.get("/dashboard")
async def get_dashboard(
    role: str = Query("supply_chain_director"),
    _: dict = Depends(get_current_user),
):
    state = synthetic_state.get_snapshot()
    return ok({
        "kpis": state["kpis"],
        "exceptions_summary": state["exceptions_summary"],
        "map_data": {
            "active_engineers": state["active_engineer_count"],
            "lockers_healthy": state["lockers_healthy_pct"],
            "shipments_in_transit": state["shipments_in_transit"],
        },
        "last_refresh": state["last_refresh"],
    })


@router.get("/map")
async def get_map(
    layers: str = Query("engineers,lockers,shipments,warehouses"),
    region: str | None = Query(None),
    _: dict = Depends(get_current_user),
):
    state = synthetic_state.get_snapshot()
    active_layers = layers.split(",")
    result = {}

    if "engineers" in active_layers:
        engineers = state.get("engineer_locations", [])
        if region:
            engineers = [e for e in engineers if e.get("region") == region]
        result["engineers"] = engineers[:200]

    if "lockers" in active_layers:
        result["lockers"] = state.get("locker_status", [])[:500]

    if "warehouses" in active_layers:
        result["warehouses"] = state.get("warehouse_status", [])

    if "shipments" in active_layers:
        result["shipments"] = state.get("shipments", [])[:50]

    return ok(result)


@router.get("/lockers")
async def get_lockers(
    region: str | None = Query(None),
    status: str | None = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, le=200),
    _: dict = Depends(get_current_user),
):
    state = synthetic_state.get_snapshot()
    lockers = state.get("locker_status", [])
    if region:
        lockers = [l for l in lockers if l.get("region") == region]
    if status == "alert":
        lockers = [l for l in lockers if l.get("fill_pct", 0) > 85 or not l.get("pre_8am_delivered")]
    elif status == "healthy":
        lockers = [l for l in lockers if l.get("fill_pct", 0) <= 85 and l.get("pre_8am_delivered")]
    total = len(lockers)
    start = (page - 1) * per_page
    return ok({"items": lockers[start:start + per_page], "total": total, "page": page, "per_page": per_page})


@router.get("/lockers/{bybox_site_code}")
async def get_locker_detail(bybox_site_code: str, _: dict = Depends(get_current_user)):
    state = synthetic_state.get_snapshot()
    lockers = state.get("locker_status", [])
    locker = next((l for l in lockers if l.get("bybox_site_code") == bybox_site_code), None)
    if not locker:
        return ok({"error": "Locker not found"})
    return ok(locker)


@router.get("/engineers")
async def get_engineers(
    region: str | None = Query(None),
    business_unit: str | None = Query(None),
    van_stock_status: str | None = Query(None),
    _: dict = Depends(get_current_user),
):
    state = synthetic_state.get_snapshot()
    engineers = state.get("engineer_locations", [])
    if region:
        engineers = [e for e in engineers if e.get("region") == region]
    if business_unit:
        engineers = [e for e in engineers if e.get("business_unit") == business_unit]
    if van_stock_status == "low":
        engineers = [e for e in engineers if e.get("van_stock_low")]
    return ok({"items": engineers, "total": len(engineers)})


@router.get("/engineers/{engineer_code}/van-stock")
async def get_engineer_van_stock(engineer_code: str, _: dict = Depends(get_current_user)):
    state = synthetic_state.get_snapshot()
    eng = next((e for e in state.get("engineer_locations", []) if e.get("engineer_code") == engineer_code), None)
    if not eng:
        return ok([])
    return ok(eng.get("van_stock_items", []))


# ── Van stock alerts ────────────────────────────────────────────────────────
# A low van is not information, it is a decision: move stock across from another
# van, move the job to someone who has the part, send this engineer via a locker
# or hub on the way, or order the van back up to standard. Each row carries those
# four options priced against live state.


@router.get("/van-alerts")
async def get_van_alerts(
    region: str | None = Query(None),
    severity: str | None = Query(None, description="critical | high | medium"),
    with_options: bool = Query(True),
    _: dict = Depends(get_current_user),
):
    rows = synthetic_state.van_alerts(region=region, severity=severity, include_options=with_options)
    return ok({
        "items": rows,
        "total": len(rows),
        "by_severity": {
            s: len([r for r in rows if r["severity"] == s]) for s in ("critical", "high", "medium")},
        "open": len([r for r in rows if r["status"] == "open"]),
        "resolved": len([r for r in rows if r["status"] == "resolved"]),
        "jobs_at_risk": sum(r["jobs_at_risk"] for r in rows if r["status"] == "open"),
    })


@router.get("/van-alerts/{engineer_code}")
async def get_van_alert(engineer_code: str, _: dict = Depends(get_current_user)):
    alert = synthetic_state.van_alert(engineer_code)
    if not alert:
        return ok({"error": "No open van stock alert for this engineer"})
    return ok(alert)


class ResolveRequest(BaseModel):
    action: str
    by: str
    params: dict | None = None


@router.post("/van-alerts/{engineer_code}/resolve")
async def resolve_van_alert(engineer_code: str, req: ResolveRequest, _: dict = Depends(_WRITE)):
    result = synthetic_state.resolve_van_alert(engineer_code, req.action, req.by, req.params)
    if "error" not in result:
        await ws_manager.broadcast("visibility", "van_alert_resolved",
                                   {"engineer_code": engineer_code, **result})
    return ok(result)


# ── Pre-8AM locker misses ───────────────────────────────────────────────────


@router.get("/locker-misses")
async def get_locker_misses(
    region: str | None = Query(None),
    with_options: bool = Query(True),
    _: dict = Depends(get_current_user),
):
    rows = synthetic_state.locker_misses(region=region, include_options=with_options)
    return ok({
        "items": rows, "total": len(rows),
        "open": len([r for r in rows if r["status"] == "open"]),
        "engineers_affected": sum(r["engineers_affected"] for r in rows if r["status"] == "open"),
        "jobs_at_risk": sum(r["jobs_at_risk"] for r in rows if r["status"] == "open"),
        "by_reason": {
            reason: len([r for r in rows if r["reason"] == reason])
            for reason in {r["reason"] for r in rows}},
    })


@router.post("/locker-misses/{site_code}/resolve")
async def resolve_locker_miss(site_code: str, req: ResolveRequest, _: dict = Depends(_WRITE)):
    result = synthetic_state.resolve_locker_miss(site_code, req.action, req.by, req.params)
    if "error" not in result:
        await ws_manager.broadcast("visibility", "locker_miss_resolved",
                                   {"site_code": site_code, **result})
    return ok(result)


@router.get("/resolution-log")
async def get_resolution_log(limit: int = Query(40, le=200), _: dict = Depends(get_current_user)):
    state = synthetic_state.get_snapshot()
    return ok({
        "items": state.get("resolution_log", [])[:limit],
        "integrations": state.get("integration_log", [])[:limit],
    })


@router.get("/inbound-shipments")
async def get_inbound_shipments(
    status: str | None = Query(None),
    supplier_id: str | None = Query(None),
    _: dict = Depends(get_current_user),
):
    state = synthetic_state.get_snapshot()
    shipments = state.get("shipments", [])
    if status:
        shipments = [s for s in shipments if s.get("status") == status]
    return ok({"items": shipments, "total": len(shipments)})


@router.get("/warehouse-throughput/{warehouse_code}")
async def get_warehouse_throughput(warehouse_code: str, hours: int = Query(24), _: dict = Depends(get_current_user)):
    state = synthetic_state.get_snapshot()
    wh = next((w for w in state.get("warehouse_status", []) if w.get("code") == warehouse_code), None)
    if not wh:
        return ok({})
    return ok({**wh, "chart_data": wh.get("throughput_chart", [])})


@router.websocket("/ws/visibility")
async def websocket_visibility(websocket: WebSocket):
    await ws_manager.connect(websocket, "visibility")
    # Prime THIS client only, so a freshly opened page is live straight away
    # rather than waiting out a broadcast interval.
    #
    # It must not do more than that. This handler used to run its own loop that
    # re-broadcast to the whole channel every interval — which meant two
    # independent producers were publishing `engineer_location` on the same
    # channel (the scheduler's `broadcast_tick` in main.py, and this), with
    # different payloads and different lengths, once per open connection. A page
    # that replaced its roster from whichever arrived last oscillated between
    # them. The scheduler is the single producer; this socket now only listens.
    state = synthetic_state.get_snapshot()
    await ws_manager.send(websocket, "throughput", state.get("warehouse_status", []))
    await ws_manager.send(websocket, "engineer_location", state.get("engineer_locations", []))
    try:
        while True:
            await asyncio.sleep(TICK_INTERVAL_S)
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket, "visibility")
