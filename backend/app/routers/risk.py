from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from app.services.response import ok
from app.synthetic.state import synthetic_state
from app.auth.rbac import get_current_user

router = APIRouter(prefix="/api/v1/risk", tags=["risk"], dependencies=[Depends(get_current_user)])


@router.get("/warehouse-health")
async def get_warehouse_health():
    state = synthetic_state.get_snapshot()
    return ok(state.get("warehouse_status", []))


@router.get("/labour-assessment")
async def get_labour_assessment():
    state = synthetic_state.get_snapshot()
    return ok(state.get("labour_assessments", []))


@router.get("/labour-assessment/{warehouse_code}/history")
async def get_labour_assessment_history(warehouse_code: str):
    synthetic_state.get_snapshot()  # ensure initialised
    return ok(synthetic_state.get_labour_history(warehouse_code))


@router.get("/suppliers")
async def get_suppliers(
    sort: str = Query("otif_desc"),
    filter: str | None = Query(None),
    page: int = Query(1, ge=1),
):
    state = synthetic_state.get_snapshot()
    suppliers = state.get("supplier_scorecards", [])
    if filter == "at_risk":
        suppliers = [s for s in suppliers if s.get("composite_risk_score", 100) < 60 or s.get("otif_score", 100) < 80]
    if "otif_asc" in sort:
        suppliers = sorted(suppliers, key=lambda x: x.get("otif_score", 0))
    elif "risk_desc" in sort:
        suppliers = sorted(suppliers, key=lambda x: x.get("composite_risk_score", 100))
    else:
        suppliers = sorted(suppliers, key=lambda x: x.get("otif_score", 0), reverse=True)
    per_page = 20
    start = (page - 1) * per_page
    return ok({"items": suppliers[start:start + per_page], "total": len(suppliers), "page": page})


@router.get("/suppliers/{supplier_code}/scorecard")
async def get_supplier_scorecard(supplier_code: str):
    state = synthetic_state.get_snapshot()
    suppliers = state.get("supplier_scorecards", [])
    supplier = next((s for s in suppliers if s.get("supplier_code") == supplier_code), None)
    if not supplier:
        return ok({"error": "Supplier not found"})
    return ok({**supplier, "weekly_history": synthetic_state.get_supplier_history(supplier_code)})


class ScenarioRequest(BaseModel):
    scenario_type: str
    parameters: dict


@router.post("/disruption-scenarios/model")
async def model_disruption_scenario(req: ScenarioRequest):
    result = synthetic_state.model_scenario(req.scenario_type, req.parameters)
    return ok(result)
