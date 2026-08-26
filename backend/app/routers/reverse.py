from fastapi import APIRouter, Depends, Query
from app.services.response import ok
from app.synthetic.state import synthetic_state
from app.auth.rbac import get_current_user

router = APIRouter(prefix="/api/v1/reverse", tags=["reverse"], dependencies=[Depends(get_current_user)])


@router.get("/pipeline")
async def get_reverse_pipeline(month: str | None = Query(None)):
    state = synthetic_state.get_snapshot()
    return ok(state.get("reverse_pipeline", {}))


@router.get("/sustainability-dashboard")
async def get_sustainability_dashboard():
    state = synthetic_state.get_snapshot()
    return ok(state.get("sustainability_dashboard", {}))


@router.get("/hts-batches")
async def get_hts_batches():
    state = synthetic_state.get_snapshot()
    return ok(state.get("hts_batches", []))


@router.get("/scope3-emissions")
async def get_scope3_emissions():
    state = synthetic_state.get_snapshot()
    return ok(state.get("scope3_emissions", {}))


@router.get("/circular-economy-kpis")
async def get_circular_economy_kpis():
    state = synthetic_state.get_snapshot()
    return ok(state.get("circular_economy_kpis", {}))
