from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from app.services.response import ok
from app.services.agent_engine import agent_engine
from app.synthetic.actions import ACTION_THRESHOLDS
from app.synthetic.state import synthetic_state
from app.auth.rbac import get_current_user, require_any_permission

router = APIRouter(prefix="/api/v1/demand", tags=["demand"], dependencies=[Depends(get_current_user)])


@router.get("/signals")
async def get_demand_signals():
    state = synthetic_state.get_snapshot()
    return ok(state.get("demand_signals", {}))


@router.get("/forecast/{sku_code}")
async def get_forecast(
    sku_code: str,
    horizon: int = Query(90, description="30, 90, or 180"),
    region: str | None = Query(None),
    business_unit: str | None = Query(None),
):
    state = synthetic_state.get_snapshot()
    forecasts = state.get("forecasts", {})
    if sku_code not in forecasts:
        forecast = synthetic_state.generate_forecast(sku_code, horizon)
        forecasts[sku_code] = forecast  # cache for subsequent requests
    return ok(forecasts[sku_code])


@router.get("/inventory")
async def get_inventory(
    page: int = Query(1, ge=1),
    per_page: int = Query(25, ge=1, le=200),
    search: str | None = Query(None, description="Match on SKU code or description"),
    sku_category: str | None = Query(None),
    segment: str | None = Query(None, description="ABC/XYZ segment, e.g. AZ"),
    rag: str | None = Query(None, description="R | A | G"),
    sort: str = Query("risk", description="risk | sku_code | days_of_supply | stock_value_gbp | … (prefix '-' to reverse)"),
    warehouse_code: str | None = Query(None, description="Site code to scope quantities to (e.g. LEI_COE); omit for network totals"),
    include_sites: bool = Query(False, description="Include the per-site breakdown (heavy — use the detail endpoint instead)"),
):
    """Paged, searchable, sortable slice of the inventory catalogue.

    Designed for a catalogue of 1000+ SKUs: filtering, sorting and paging all
    happen server-side, and the heavy nested per-site breakdown is omitted from
    list responses (fetch it per SKU from /inventory/{sku_code})."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.query_inventory(
        page=page, per_page=per_page, search=search, category=sku_category,
        segment=segment, rag=rag, warehouse_code=warehouse_code,
        sort=sort, include_sites=include_sites,
    ))


@router.get("/inventory/summary")
async def get_inventory_summary(
    search: str | None = Query(None),
    sku_category: str | None = Query(None),
    segment: str | None = Query(None),
    warehouse_code: str | None = Query(None),
):
    """Every aggregate the page needs — KPIs, RAG mix, ABC/XYZ matrix, category
    counts, per-site health and forecast quality — computed over the FULL filtered
    catalogue so the numbers stay correct whatever page of rows is on screen."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_inventory_summary(
        search=search, category=sku_category, segment=segment, warehouse_code=warehouse_code))


@router.get("/inventory/{sku_code}")
async def get_inventory_item(sku_code: str, warehouse_code: str | None = Query(None)):
    """Full position for one SKU — per-site breakdown, forecast quality, drivers."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_inventory_item(sku_code, warehouse_code))


@router.get("/network")
async def get_demand_network():
    """Two-echelon network summary: suppliers → Leicester NDC → regional hubs,
    with per-site stock health and in-flight replenishment on each leg."""
    return ok(synthetic_state.get_demand_network())


@router.get("/transfer-orders")
async def get_transfer_orders(
    status: str | None = Query(None),
    raised_by: str | None = Query(None, description="Hub that raised the STO"),
    page: int = Query(1, ge=1), per_page: int = Query(10, ge=1, le=200),
):
    state = synthetic_state.get_snapshot()
    transfers = state.get("transfer_orders", [])
    if status and status != "all":
        transfers = [t for t in transfers if t.get("status") == status]
    if raised_by and raised_by != "all":
        transfers = [t for t in transfers if t.get("raised_by") == raised_by]
    return ok({**synthetic_state._page(transfers, page, per_page),
               "statuses": sorted({t.get("status") for t in state.get("transfer_orders", []) if t.get("status")})})


class TransferCreateRequest(BaseModel):
    sku_code: str
    to_warehouse: str
    quantity: int
    from_warehouse: str | None = None  # defaults to the Leicester NDC; set for lateral hub rebalances
    notes: str | None = None


@router.post("/transfer-orders")
async def create_transfer_order(req: TransferCreateRequest, _: dict = Depends(require_any_permission("write:po"))):
    transfer = synthetic_state.create_transfer_order(req.dict())
    return ok(transfer)


@router.get("/inventory/{sku_code}/waterfall")
async def get_inventory_waterfall(sku_code: str):
    state = synthetic_state.get_snapshot()
    inventory = state.get("inventory_positions", [])
    item = next((i for i in inventory if i.get("sku_code") == sku_code), None)
    if not item:
        item = synthetic_state.generate_waterfall(sku_code)
    return ok(item)


@router.get("/replenishment-orders")
async def get_replenishment_orders(
    status: str | None = Query(None),
    supplier_code: str | None = Query(None, description="Filter to one supplier (used by the Risk module deep-link)"),
    page: int = Query(1, ge=1), per_page: int = Query(10, ge=1, le=200),
):
    state = synthetic_state.get_snapshot()
    orders = state.get("purchase_orders", [])
    if status:
        orders = [o for o in orders if o.get("status") == status]
    if supplier_code:
        orders = [o for o in orders if o.get("supplier_code") == supplier_code]
    return ok({**synthetic_state._page(orders, page, per_page),
               "statuses": sorted({o.get("status") for o in state.get("purchase_orders", []) if o.get("status")})})


class POCreateRequest(BaseModel):
    sku_code: str
    supplier_code: str
    warehouse_code: str
    quantity: int
    po_type: str = "standard"
    notes: str | None = None


@router.post("/replenishment-orders")
async def create_replenishment_order(req: POCreateRequest, _: dict = Depends(require_any_permission("write:po"))):
    po = synthetic_state.create_purchase_order(req.dict())
    return ok(po)


@router.get("/auto-po")
async def get_auto_po_status():
    """Auto PO status — powered by ATLAS's own governed autonomy cycle
    (`agent_engine.run_autonomous_cycle`), the same one behind the approvals
    queue and Ask ATLAS, not a separate simulation loop.

    A standard PO for an amber position self-executes when it clears its gates
    (value, confidence, the replenishment capability's autonomy setting, the
    master AI switch). An emergency PO for a red position never does — the
    action catalogue marks it `autonomy="human"` because it commits an unplanned
    freight premium — so a critical SKU shows here as awaiting a human, not as
    silently ordered.
    """
    state = synthetic_state.get_snapshot()
    std_cfg = ACTION_THRESHOLDS.get("raise_po_standard", {})
    emg_cfg = ACTION_THRESHOLDS.get("raise_po_emergency", {})
    replenishment_autonomy = agent_engine._autonomy.get("replenishment", "auto")
    enabled = bool(synthetic_state.ai_mode) and replenishment_autonomy == "auto"

    auto_pos = [p for p in state.get("purchase_orders", []) if p.get("is_auto_generated")]
    critical_skus = [i["sku_code"] for i in state.get("inventory_positions", []) if i.get("rag_status") == "R"]

    pending_emergency = [
        r for r in agent_engine._pending_recommendations()
        if (r.get("action") or {}).get("threshold_key") == "raise_po_emergency"
    ]

    today = datetime.now(timezone.utc).date().isoformat()
    recent = [e for e in agent_engine.activity(200)
              if e.get("threshold_key") in ("raise_po_standard", "raise_po_emergency", "expedite_po")
              and (e.get("ts") or "")[:10] == today]

    return ok({
        "enabled": enabled,
        "trigger": (f"Standard PO self-executes under £{std_cfg.get('value_ceiling_gbp', 0):,} at "
                    f"{std_cfg.get('confidence_floor', 0)}%+ confidence ({std_cfg.get('autonomy', 'auto')}). "
                    "Emergency PO always waits for you — "
                    f"{(emg_cfg.get('why_human') or 'unplanned freight spend').rstrip('.')}."),
        "replenishment_autonomy": replenishment_autonomy,
        "critical_skus": critical_skus,
        "pending_emergency_approval": len(pending_emergency),
        "auto_pos_open": [p for p in auto_pos if p.get("status") in ("draft", "confirmed", "in_transit")],
        "actions_today": len(recent),
        "recent": recent[:10],
    })


@router.get("/heat-pump-pipeline")
async def get_heat_pump_pipeline():
    """OEM pipeline derived from the supplier master, live PO book and scorecards."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_heat_pump_pipeline())


@router.get("/smart-meter-dashboard")
async def get_smart_meter_dashboard():
    """Kit stock read from real smart-meter inventory; progress from MHHS signals."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_smart_meter_dashboard())


@router.get("/reference-data")
async def get_reference_data():
    """Master data for the module — sites, supplier master and categories — so the
    UI holds no hard-coded copy of the network or supplier list."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_reference_data())


# ── Causal engine: Position · Execute · Orchestrate · Learn ──────────────────

@router.get("/dependent-demand")
async def get_dependent_demand(horizon: int = Query(30)):
    """SENSE — install/CPQ pipeline exploded through BOMs into part demand."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_dependent_demand(horizon))


@router.get("/replenishment-routing")
async def get_replenishment_routing():
    """EXECUTE — which document fills a shortfall at which echelon, and who raises
    it. NDC shortfall → supplier PO; hub shortfall → STO raised by the hub."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_replenishment_routing())


@router.get("/meio")
async def get_meio(
    page: int = Query(1, ge=1), per_page: int = Query(10, ge=1, le=200),
    segment: str | None = Query(None), sku_category: str | None = Query(None),
):
    """POSITION — multi-echelon (risk-pooling) vs decentralised safety stock."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_meio(page, per_page, segment, sku_category))


@router.get("/financials")
async def get_financials(
    segment: str | None = Query(None), sku_category: str | None = Query(None),
    warehouse_code: str | None = Query(None),
):
    """Working capital, GMROI, turns and value at risk."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_financials(segment, sku_category, warehouse_code))


@router.get("/excess-dispositions")
async def get_excess_dispositions(
    page: int = Query(1, ge=1),
    per_page: int = Query(10, ge=1, le=100),
    segment: str | None = Query(None), sku_category: str | None = Query(None),
    warehouse_code: str | None = Query(None),
):
    """POSITION — excess & obsolescence with recommended dispositions, paged."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_excess_dispositions(page, per_page, segment, sku_category, warehouse_code))


@router.post("/excess-dispositions/apply-all")
async def apply_all_dispositions(
    max_items: int | None = Query(None, description="Cap the batch; omit to action every open excess position"),
    _: dict = Depends(require_any_permission("write:po")),
):
    """POSITION — apply the recommended disposition to all open excess positions."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.apply_all_dispositions(max_items))


class DispositionRequest(BaseModel):
    sku_code: str
    action: str = "markdown"   # rebalance | return_to_vendor | markdown | write_off
    units: int | None = None
    notes: str | None = None


@router.post("/excess-dispositions")
async def create_disposition(req: DispositionRequest, _: dict = Depends(require_any_permission("write:po"))):
    return ok(synthetic_state.create_disposition(req.dict()))


@router.get("/worklist")
async def get_planner_worklist(
    page: int = Query(1, ge=1), per_page: int = Query(10, ge=1, le=200),
    family: str | None = Query(None, description="replenish | redistribute | reduce | derisk"),
    kind: str | None = Query(None, description="purchase | expedite | transfer | rebalance | stockout | low_stock | excess | supplier"),
    sort: str = Query("priority", description="priority | value | benefit | sla | sku"),
    segment: str | None = Query(None), sku_category: str | None = Query(None),
    warehouse_code: str | None = Query(None),
):
    """LEARN — one £-at-risk worklist with owners and SLAs, grouped into work-type
    families (replenish / redistribute / reduce / de-risk). Each row carries only
    the context relevant to its type — a route + qty for a move, a cover gap for a
    shortage, a disposition for excess, an OTIF score for a supplier risk. The
    former Intelligent Replenishment Planner's DRP recommendations are the concrete
    moves here. Family/kind counts span the whole catalogue; only the requested page
    of actions is returned."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_planner_worklist(page, per_page, kind, family, sort, segment, sku_category, warehouse_code))


@router.get("/forecast-tuning")
async def get_forecast_tuning(
    page: int = Query(1, ge=1), per_page: int = Query(10, ge=1, le=200),
    sort: str = Query("bias", description="bias | mape | value | impact | sku"),
    segment: str | None = Query(None), sku_category: str | None = Query(None),
    warehouse_code: str | None = Query(None),
    top_pct: float | None = Query(None, gt=0, le=100, description="Return the top N% by sort instead of paging"),
):
    """LEARN — forecast bias and the buffer-policy nudge it implies. Worst bias
    first; portfolio totals span the whole catalogue."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_forecast_tuning(page, per_page, sort, segment, sku_category, warehouse_code, top_pct))


@router.get("/sop-plan")
async def get_sop_plan(periods: int = Query(6)):
    """ORCHESTRATE — S&OP demand/supply/finance reconciliation + allocation."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.get_sop_plan(periods))


class SimulateRequest(BaseModel):
    demand_shock_pct: float = 0
    lead_slip_days: int = 0
    category: str | None = None


@router.post("/simulate")
async def simulate_network(req: SimulateRequest):
    """ORCHESTRATE — network-scale digital-twin what-if (no state mutation)."""
    synthetic_state.get_snapshot()
    return ok(synthetic_state.simulate_network(req.demand_shock_pct, req.lead_slip_days, req.category))


@router.post("/replenishment-orders/{po_number}/expedite")
async def expedite_purchase_order(po_number: str, _: dict = Depends(require_any_permission("write:po"))):
    """EXECUTE — expedite an existing in-flight PO (emergency handling, pulled-in
    ETA), rather than raising a new order."""
    po = synthetic_state.expedite_purchase_order(po_number)
    if not po:
        raise HTTPException(status_code=404, detail=f"PO {po_number} not found")
    return ok(po)


@router.post("/replenishment-orders/{po_number}/receive")
async def receive_purchase_order(po_number: str, _: dict = Depends(require_any_permission("write:po"))):
    """EXECUTE — goods receipt for an inbound supplier PO."""
    return ok(synthetic_state.receive_purchase_order(po_number))


@router.post("/transfer-orders/{transfer_id}/receive")
async def receive_transfer(transfer_id: str, _: dict = Depends(require_any_permission("write:po"))):
    """EXECUTE — confirm a trunker transfer delivered into a hub."""
    return ok(synthetic_state.receive_transfer(transfer_id))
