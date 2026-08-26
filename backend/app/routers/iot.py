from fastapi import APIRouter, Depends
from pydantic import BaseModel
from app.services.response import ok
from app.synthetic.state import synthetic_state
from app.auth.rbac import get_current_user

router = APIRouter(prefix="/api/v1/iot", tags=["iot"])


class BoilerSignalRequest(BaseModel):
    device_id: str
    fault_type: str
    fault_probability: float
    postcode: str
    boiler_brand: str
    boiler_model: str
    age_years: float | None = None
    region: str | None = None


@router.post("/boiler-signals")
async def ingest_boiler_signal(req: BoilerSignalRequest):
    result = synthetic_state.process_boiler_signal(req.dict())
    return ok(result)


@router.get("/fault-pipeline")
async def get_fault_pipeline(_: dict = Depends(get_current_user)):
    # Derived rather than raw: each signal carries the part that clears it and
    # whether that part is actually within reach (see state.get_fault_pipeline).
    return ok(synthetic_state.get_fault_pipeline())


@router.get("/estate-health")
async def get_estate_health(_: dict = Depends(get_current_user)):
    """Health of the sensing layer itself, plus the parts-cover rate the module
    exists to move."""
    return ok(synthetic_state.get_iot_estate_health())


@router.get("/predictive-replacements")
async def get_predictive_replacements(_: dict = Depends(get_current_user)):
    state = synthetic_state.get_snapshot()
    return ok(state.get("predictive_replacements", []))


@router.get("/smart-meter-status")
async def get_smart_meter_status(_: dict = Depends(get_current_user)):
    state = synthetic_state.get_snapshot()
    return ok(state.get("smart_meter_status", {}))


@router.get("/van-telematics")
async def get_van_telematics(_: dict = Depends(get_current_user)):
    state = synthetic_state.get_snapshot()
    return ok(state.get("van_telematics", []))
