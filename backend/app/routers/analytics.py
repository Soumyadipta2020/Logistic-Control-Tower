from fastapi import APIRouter, Depends, Query
from app.services.response import ok
from app.synthetic.state import synthetic_state
from app.auth.rbac import get_current_user, require_any_permission

router = APIRouter(prefix="/api/v1/analytics", tags=["analytics"], dependencies=[Depends(get_current_user)])


@router.get("/executive-kpis")
async def get_executive_kpis(period: str = Query("current_month")):
    state = synthetic_state.get_snapshot()
    return ok(state.get("executive_kpis", {}))


@router.get("/operational-kpis")
async def get_operational_kpis():
    state = synthetic_state.get_snapshot()
    return ok(state.get("operational_kpis", {}))


@router.get("/procurement-kpis")
async def get_procurement_kpis():
    state = synthetic_state.get_snapshot()
    return ok(state.get("procurement_kpis", {}))


@router.get("/sustainability-kpis")
async def get_sustainability_kpis():
    state = synthetic_state.get_snapshot()
    return ok(state.get("sustainability_kpis", {}))


@router.get("/field-dispatcher-kpis")
async def get_field_dispatcher_kpis():
    state = synthetic_state.get_snapshot()
    return ok(state.get("field_dispatcher_kpis", {}))


# Deliberately on `analytics` and not on `visibility` or `transport`: the measure is
# the UNION of a Field Operations failure (van short of the part) and a Transport
# Control one (van will not arrive in time), so it belongs to neither module alone.
# Both module pages read it from here, which is what keeps their two numbers and the
# Executive Dashboard headline from drifting apart.
@router.get("/jobs-at-risk")
async def get_jobs_at_risk(region: str | None = Query(None)):
    synthetic_state.get_snapshot()  # ensure initialised
    return ok(synthetic_state.jobs_at_sla_risk(region=region))


@router.get("/transport-kpis")
async def get_transport_kpis():
    state = synthetic_state.get_snapshot()
    return ok(state.get("transport_kpis", {}))


@router.get("/reports/weekly")
async def get_weekly_report(
    week_of: str | None = Query(None),
    format: str = Query("json"),
):
    state = synthetic_state.get_snapshot()
    report = synthetic_state.generate_weekly_report(week_of)
    return ok(report)


@router.get("/export")
async def export_data(
    entity: str = Query(..., description="exceptions|kpis|supplier_scorecards"),
    from_: str | None = Query(None, alias="from"),
    to: str | None = Query(None),
    format: str = Query("json"),
    _: dict = Depends(require_any_permission("export:all", "export:finance", "export:sustainability")),
):
    state = synthetic_state.get_snapshot()
    if entity == "exceptions":
        data = state.get("exceptions", [])
    elif entity == "kpis":
        data = [state.get("executive_kpis", {})]
    elif entity == "supplier_scorecards":
        data = state.get("supplier_scorecards", [])
    else:
        data = []
    return ok({"entity": entity, "count": len(data), "data": data[:500]})
