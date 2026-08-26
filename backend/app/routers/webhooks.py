import hashlib
import hmac
from fastapi import APIRouter, Request, Header, HTTPException
from app.services.response import ok
from app.services.websocket_manager import ws_manager
from app.synthetic.state import synthetic_state

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


def verify_hmac(payload: bytes, signature: str | None, secret: str) -> bool:
    if not signature:
        return False
    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.replace("sha256=", ""))


@router.post("/tvs-scs/throughput-update")
async def tvs_throughput(request: Request, x_tvs_signature: str | None = Header(None)):
    body = await request.json()
    synthetic_state.update_warehouse_throughput(body)
    await ws_manager.broadcast("visibility", "throughput", body)
    return ok({"received": True})


@router.post("/tvs-scs/dispatch-event")
async def tvs_dispatch(request: Request):
    body = await request.json()
    synthetic_state.process_dispatch_event(body)
    return ok({"received": True})


@router.post("/salesforce/job-update")
async def sf_job_update(request: Request):
    body = await request.json()
    synthetic_state.update_job_status(body)
    return ok({"received": True})


@router.post("/salesforce/van-stock-transaction")
async def sf_van_stock(request: Request):
    body = await request.json()
    synthetic_state.update_van_stock(body)
    return ok({"received": True})


@router.post("/bybox/delivery-confirmation")
async def bybox_delivery(request: Request):
    body = await request.json()
    synthetic_state.confirm_locker_delivery(body)
    await ws_manager.broadcast("visibility", "locker_update", body)
    return ok({"received": True})


@router.post("/bybox/collection-event")
async def bybox_collection(request: Request):
    body = await request.json()
    synthetic_state.process_locker_collection(body)
    return ok({"received": True})


@router.post("/bybox/locker-status")
async def bybox_locker_status(request: Request):
    body = await request.json()
    synthetic_state.update_locker_status(body)
    return ok({"received": True})


@router.post("/hive/boiler-signal")
async def hive_boiler_signal(request: Request):
    body = await request.json()
    result = synthetic_state.process_boiler_signal(body)
    if result.get("pre_positioning_triggered"):
        await ws_manager.broadcast_all("iot_alert", result)
    return ok({"received": True, **result})


@router.post("/hive/meter-commissioning")
async def hive_meter(request: Request):
    body = await request.json()
    synthetic_state.process_meter_commissioning(body)
    return ok({"received": True})


@router.post("/ramco/collection-confirmation")
async def ramco_collection(request: Request):
    body = await request.json()
    synthetic_state.process_ramco_collection(body)
    return ok({"received": True})


@router.post("/hts/batch-status-update")
async def hts_batch_update(request: Request):
    body = await request.json()
    synthetic_state.update_hts_batch(body)
    return ok({"received": True})


@router.post("/wolseley/stock-update")
async def wolseley_stock(request: Request):
    body = await request.json()
    synthetic_state.update_wolseley_stock(body)
    return ok({"received": True})
