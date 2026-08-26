from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from app.services.response import ok
from app.synthetic.state import synthetic_state
from app.auth.rbac import get_current_user, require_any_permission

router = APIRouter(prefix="/api/v1/field", tags=["field"], dependencies=[Depends(get_current_user)])


@router.get("/engineers/{engineer_code}/mobile-dashboard")
async def get_mobile_dashboard(engineer_code: str):
    state = synthetic_state.get_snapshot()
    eng = next((e for e in state.get("engineer_locations", []) if e.get("engineer_code") == engineer_code), None)
    if not eng:
        return ok({"error": "Engineer not found"})
    return ok({
        "engineer": eng,
        "today_jobs": synthetic_state.get_engineer_jobs(engineer_code),
        "van_stock_items": eng.get("van_stock_items", []),
        "pending_alerts": eng.get("pending_alerts", []),
        "locker_assignments": eng.get("locker_assignments", []),
    })


@router.get("/engineers/{engineer_code}/jobs")
async def get_engineer_jobs(engineer_code: str):
    return ok(synthetic_state.get_engineer_jobs(engineer_code))


class LockerUnlockRequest(BaseModel):
    locker_site_code: str
    sku_codes: list[str]


@router.post("/engineers/{engineer_code}/locker/unlock")
async def unlock_locker(engineer_code: str, req: LockerUnlockRequest, _: dict = Depends(require_any_permission("write:locker"))):
    result = synthetic_state.unlock_locker(engineer_code, req.locker_site_code, req.sku_codes)
    return ok(result)


@router.get("/parts/delivery-mode")
async def recommend_delivery_mode(
    sku_code: str = Query(...),
    job_code: str = Query(...),
    urgency: str = Query("normal"),
):
    recommendation = synthetic_state.recommend_delivery_mode(sku_code, job_code, urgency)
    return ok(recommendation)


class TransferRequest(BaseModel):
    requesting_engineer_code: str
    sku_code: str
    quantity: int
    reason: str


@router.post("/transfers")
async def request_transfer(req: TransferRequest, _: dict = Depends(require_any_permission("write:transfer"))):
    result = synthetic_state.request_transfer(req.dict())
    return ok(result)


@router.put("/transfers/{transfer_id}/approve")
async def approve_transfer(transfer_id: str, approved_by: str, meeting_point_override: str | None = None, _: dict = Depends(require_any_permission("write:transfer"))):
    result = synthetic_state.approve_transfer(transfer_id, approved_by, meeting_point_override)
    return ok(result)


@router.get("/emergency-counters")
async def get_emergency_counters(
    sku_code: str = Query(...),
    engineer_postcode: str = Query(...),
    radius_miles: int = Query(10),
):
    counters = synthetic_state.find_emergency_counters(sku_code, engineer_postcode, radius_miles)
    return ok(counters)


class DecommissionLog(BaseModel):
    boiler_brand: str
    boiler_model: str
    serial_number: str
    disposal_route: str


@router.post("/jobs/{job_code}/decommission-log")
async def log_decommission(job_code: str, req: DecommissionLog, _: dict = Depends(require_any_permission("write:job_completion"))):
    result = synthetic_state.log_decommission(job_code, req.dict())
    return ok(result)
