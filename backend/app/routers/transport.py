import random
import time
from datetime import date

import httpx
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from app.services.response import ok
from app.synthetic.state import synthetic_state
from app.auth.rbac import get_current_user, require_any_permission

router = APIRouter(prefix="/api/v1/transport", tags=["transport"], dependencies=[Depends(get_current_user)])

# The zone list and the fuel/CO2 rates live with the optimiser that prices them,
# so the map overlay and the routing cost can never disagree about where a
# charging zone is or what a mile costs.
from app.synthetic import routing  # noqa: E402
from app.synthetic.routing import (  # noqa: E402
    CAZ_ZONES, FUEL_PPM, DIESEL_CO2_KG_PER_MILE,
)

WORKING_DAYS_PER_MONTH = 22


def _fleet_with_positions(state: dict) -> list:
    """Join fleet vehicles with live engineer positions — single source of
    truth shared with the Live Visibility Hub."""
    positions = {
        e["engineer_code"]: e
        for e in state.get("engineer_locations", [])
    }
    routes = state.get("engineer_routes", {})
    fleet = []
    for v in state.get("fleet_vehicles", []):
        eng = positions.get(v["engineer_code"])
        r = routes.get(v["engineer_code"])
        next_stop = next((s for s in r["stops"] if s["status"] == "next"), None) if r else None
        fleet.append({
            **v,
            "latitude": eng.get("latitude") if eng else None,
            "longitude": eng.get("longitude") if eng else None,
            "job_status": eng.get("job_status") if eng else "off_duty",
            "van_stock_low": eng.get("van_stock_low", False) if eng else False,
            "route": {
                "stops_total": r["stops_total"],
                "stops_completed": r["stops_completed"],
                "stops_blocked": len([st for st in r.get("stops", [])
                                      if st.get("status") == "blocked"]),
                "next_postcode": next_stop["postcode"] if next_stop else None,
                "next_eta": next_stop["planned_arrival"] if next_stop else None,
                "miles_saved": r["miles_saved"],
                "mins_saved": r["mins_saved"],
                "optimization_applied": r["optimization_applied"],
                # How far behind this round is running, so a late van is visible
                # in the fleet list without opening it.
                "delay_mins": r.get("delay_mins", 0),
                "delay_cause": r.get("delay_cause"),
                # Covers both sources of a pickup: one the optimiser planned
                # because a part is not in van stock, and one a dispatcher
                # inserted by hand resolving a van-stock alert.
                "has_collection_stop": any(st.get("stop_kind") == "collection"
                                           for st in r.get("stops", [])),
                "parts_summary": (r.get("optimisation") or {}).get("parts_summary", {}),
            } if r else None,
        })
    return fleet


@router.get("/summary")
async def get_fleet_summary():
    state = synthetic_state.get_snapshot()
    fleet = _fleet_with_positions(state)
    total = len(fleet)
    ev_count = len([v for v in fleet if v["fuel_type"] == "ev"])
    walkaround_done = len([v for v in fleet if v["walkaround_completed"]])
    open_defects = sum(len([d for d in v["defects"] if d["status"] == "open"]) for v in fleet)
    return ok({
        "fleet_size": total,
        "active_vehicles": len([v for v in fleet if v["job_status"] in ("en_route", "on_site", "available") and not v["vor"]]),
        "en_route": len([v for v in fleet if v["job_status"] == "en_route" and not v["vor"]]),
        "vor_count": len([v for v in fleet if v["vor"]]),
        "walkaround_compliance_pct": round(walkaround_done / total * 100, 1) if total else 0,
        "walkaround_missing": total - walkaround_done,
        "open_defects": open_defects,
        "mot_due_30d": len([v for v in fleet if v["mot_due_days"] <= 30]),
        "service_due_soon": len([v for v in fleet if v["service_due_miles"] < 1000]),
        "caz_non_compliant": len([v for v in fleet if not v["caz_compliant"]]),
        "ev_fleet_pct": round(ev_count / total * 100, 1) if total else 0,
        "ev_count": ev_count,
        "avg_driver_score": round(sum(v["driver_score"] for v in fleet) / total, 1) if total else 0,
        "fleet_co2_kg_month": sum(v["co2_kg_month"] for v in fleet),
        "fleet_fuel_cost_month_gbp": sum(v["fuel_cost_month_gbp"] for v in fleet),
        "last_refresh": state.get("last_refresh"),
    })


@router.get("/fleet")
async def get_fleet(
    status: str | None = Query(None, description="all | vor | walkaround_missing | defects | mot_due | caz_risk | ev"),
    region: str | None = Query(None),
    search: str | None = Query(None),
):
    state = synthetic_state.get_snapshot()
    fleet = _fleet_with_positions(state)
    if region:
        fleet = [v for v in fleet if v["region"] == region]
    if status == "vor":
        fleet = [v for v in fleet if v["vor"]]
    elif status == "walkaround_missing":
        fleet = [v for v in fleet if not v["walkaround_completed"]]
    elif status == "defects":
        fleet = [v for v in fleet if any(d["status"] == "open" for d in v["defects"])]
    elif status == "mot_due":
        fleet = [v for v in fleet if v["mot_due_days"] <= 30]
    elif status == "caz_risk":
        fleet = [v for v in fleet if not v["caz_compliant"]]
    elif status == "ev":
        fleet = [v for v in fleet if v["fuel_type"] == "ev"]
    if search:
        q = search.lower()
        fleet = [v for v in fleet if q in v["registration"].lower() or q in v["engineer_name"].lower() or q in v["make_model"].lower()]
    return ok({"items": fleet, "total": len(fleet)})


@router.get("/caz-zones")
async def get_caz_zones():
    return ok(CAZ_ZONES)


# ── Road routing (OSRM public API) + synthetic traffic layer ────────────────

OSRM_BASE = "https://router.project-osrm.org/route/v1/driving/"
_ROAD_CACHE_TTL_S = 120  # live position drifts every 60s tick; re-route shortly after

_INCIDENT_TYPES = [
    ("road_closure", "⛔", "Road closed — diversion in place", "high", (12, 25)),
    ("roadworks", "🚧", "Roadworks — temporary traffic lights", "medium", (4, 12)),
    ("accident", "💥", "Accident reported — lane blocked", "high", (8, 20)),
    ("congestion", "🐌", "Slow traffic — congestion building", "low", (3, 8)),
    ("speed_camera", "📷", "Average speed check zone", "info", (0, 0)),
]

CONGESTION_FACTOR = {"free": 0.0, "moderate": 0.25, "heavy": 0.6}

# congestion mix per scenario traffic severity: weights for free/moderate/heavy
TRAFFIC_WEIGHTS = {
    "normal":   [0.55, 0.30, 0.15],
    "elevated": [0.40, 0.35, 0.25],
    "high":     [0.28, 0.40, 0.32],
    "severe":   [0.15, 0.35, 0.50],
}
INCIDENT_RANGE = {"normal": (0, 3), "elevated": (1, 3), "high": (1, 4), "severe": (2, 5)}


async def _fetch_osrm_geometry(points: list[tuple[float, float]]) -> dict | None:
    """points: [(lat, lon), ...] → road-following geometry, or None on failure."""
    path = ";".join(f"{lon:.5f},{lat:.5f}" for lat, lon in points)
    url = f"{OSRM_BASE}{path}?overview=full&geometries=geojson&steps=false"
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(url)
            data = r.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            return None
        rt = data["routes"][0]
        return {
            "coords": [[c[1], c[0]] for c in rt["geometry"]["coordinates"]],  # → [lat, lon]
            "distance_m": rt["distance"],
            "duration_s": rt["duration"],
        }
    except Exception:
        return None


def _build_road_route(geometry: dict, engineer_code: str, severity: str = "normal") -> dict:
    """Overlay deterministic-per-day traffic segments and incidents on the
    OSRM geometry so the display is stable between refreshes. Scenario traffic
    severity shifts the congestion mix and incident count."""
    rng = random.Random(f"{engineer_code}-{date.today().isoformat()}-{severity}")
    coords = geometry["coords"]
    n = len(coords)
    base_mins = round(geometry["duration_s"] / 60)

    # split geometry into 4–9 traffic segments
    n_seg = min(max(4, n // 60), 9)
    if n > n_seg + 2:
        cuts = sorted(rng.sample(range(2, n - 1), k=n_seg - 1))
    else:
        cuts = []
    bounds = [0, *cuts, n - 1]
    segments, delay_mins = [], 0.0
    weights = TRAFFIC_WEIGHTS.get(severity, TRAFFIC_WEIGHTS["normal"])
    for i in range(len(bounds) - 1):
        seg_coords = coords[bounds[i]:bounds[i + 1] + 1]
        congestion = rng.choices(["free", "moderate", "heavy"], weights=weights)[0]
        share = len(seg_coords) / n
        delay_mins += base_mins * share * CONGESTION_FACTOR[congestion]
        segments.append({"coords": seg_coords, "congestion": congestion})

    # incidents pinned onto the route line (more under scenario disruption)
    incidents = []
    inc_lo, inc_hi = INCIDENT_RANGE.get(severity, INCIDENT_RANGE["normal"])
    for _ in range(rng.randint(inc_lo, inc_hi)):
        kind, icon, desc, severity, (dmin, dmax) = rng.choice(_INCIDENT_TYPES)
        pt = coords[rng.randint(n // 8, max(n // 8 + 1, n - n // 8))]
        inc_delay = rng.randint(dmin, dmax) if dmax else 0
        delay_mins += inc_delay
        incidents.append({
            "type": kind, "icon": icon, "description": desc, "severity": severity,
            "latitude": pt[0], "longitude": pt[1], "delay_mins": inc_delay,
        })

    return {
        "available": True,
        "segments": segments,
        "incidents": incidents,
        "distance_miles": round(geometry["distance_m"] / 1609.34, 1),
        "base_duration_mins": base_mins,
        "traffic_delay_mins": round(delay_mins),
        "traffic_severity": severity,
    }


@router.get("/routes/{engineer_code}")
async def get_engineer_route(engineer_code: str):
    state = synthetic_state.get_snapshot()
    route = state.get("engineer_routes", {}).get(engineer_code)
    if not route:
        return ok({"error": "No active route for this engineer"})
    eng = next((e for e in state.get("engineer_locations", []) if e["engineer_code"] == engineer_code), None)
    vehicle = next((v for v in state.get("fleet_vehicles", []) if v["engineer_code"] == engineer_code), None)
    fuel = vehicle["fuel_type"] if vehicle else "diesel"

    # Road-following geometry: live van position → remaining stops.
    # Cached briefly per route; falls back to straight lines if OSRM is down.
    road_route = {"available": False}
    # Drivable only — a stop this engineer holds no accreditation for is not
    # somewhere the van is going, so drawing the road to it would be a lie.
    remaining = routing.drivable(route["stops"])
    if eng and remaining:
        severity = state.get("traffic_severity", "normal")
        cache = route.get("_road_cache")
        cache_key = (route["stops_completed"], round(eng["latitude"], 3), round(eng["longitude"], 3), severity)
        if cache and cache["key"] == cache_key and time.time() - cache["at"] < _ROAD_CACHE_TTL_S:
            road_route = cache["data"]
        else:
            points = [(eng["latitude"], eng["longitude"])] + [(s["latitude"], s["longitude"]) for s in remaining]
            geometry = await _fetch_osrm_geometry(points)
            if geometry:
                road_route = _build_road_route(geometry, engineer_code, severity)
                route["_road_cache"] = {"key": cache_key, "at": time.time(), "data": road_route}

    return ok({
        **{k: v for k, v in route.items() if k != "_road_cache"},
        # live van position — same source as the Live Visibility Hub
        "current_latitude": eng.get("latitude") if eng else None,
        "current_longitude": eng.get("longitude") if eng else None,
        "job_status": eng.get("job_status") if eng else "off_duty",
        "fuel_type": fuel,
        "fuel_saved_gbp": round(route["miles_saved"] * FUEL_PPM[fuel], 2),
        "road_route": road_route,
    })


@router.get("/route-optimization")
async def get_route_optimization():
    """Today's optimiser result across the fleet.

    Every figure here is the sum of what the optimiser actually computed per
    round — booked sequence versus optimised sequence, priced against travel,
    SLA windows, parts availability, clean air zones and drivers' hours. If a
    round was already well sequenced it contributes nothing, which is why the
    optimisation rate is not a round number.
    """
    state = synthetic_state.get_snapshot()
    routes = state.get("engineer_routes", {})
    fuel_by_eng = {v["engineer_code"]: v["fuel_type"] for v in state.get("fleet_vehicles", [])}
    fleet = state.get("fleet_vehicles", [])

    optimized = [r for r in routes.values() if r["optimization_applied"]]
    total_miles_saved = round(sum(r["miles_saved"] for r in optimized), 1)
    total_mins_saved = sum(r["mins_saved"] for r in optimized)
    fuel_saved_today = round(sum(
        r["miles_saved"] * FUEL_PPM[fuel_by_eng.get(r["engineer_code"], "diesel")]
        for r in optimized), 2)
    co2_saved_today = round(sum(
        r["miles_saved"] * DIESEL_CO2_KG_PER_MILE
        for r in optimized
        if fuel_by_eng.get(r["engineer_code"], "diesel") == "diesel"), 1)

    # EV savings vs diesel-equivalent running cost
    ev_saving_month = round(sum(
        v["miles_today"] * WORKING_DAYS_PER_MONTH * (FUEL_PPM["diesel"] - FUEL_PPM["ev"])
        for v in fleet if v["fuel_type"] == "ev"), 0)

    # ── What the optimiser is actually trading, rolled up across the fleet ────
    # This is the part a distance-only optimiser cannot report: the money is not
    # all in fuel, and on most days it is not even mostly in fuel.
    factor_totals: dict[str, dict] = {}
    parts_totals: dict[str, int] = {}
    reallocation: list[dict] = []
    cost_before = cost_after = 0.0
    sla_jobs_protected = sla_mins_recovered = overtime_mins_saved = 0
    caz_saved = 0.0
    names = {e["engineer_code"]: e["name"] for e in state.get("engineer_locations", [])}

    for r in routes.values():
        plan = r.get("optimisation")
        if not plan:
            continue
        cost_before += plan["baseline"]["cost_gbp"]
        cost_after += plan["optimised"]["cost_gbp"]
        sla_jobs_protected += plan.get("sla_jobs_protected", 0)
        sla_mins_recovered += plan.get("sla_mins_recovered", 0)
        caz_saved += (plan["baseline"]["cost_breakdown"]["clean_air_zone"]
                      - plan["optimised"]["cost_breakdown"]["clean_air_zone"])
        ot = next((f for f in plan.get("factors", []) if f["key"] == "overtime"), None)
        if ot:
            overtime_mins_saved += max(0, ot["baseline"] - ot["optimised"])
        for st, n in (plan.get("parts_summary") or {}).items():
            parts_totals[st] = parts_totals.get(st, 0) + n
        for f in plan.get("factors", []):
            acc = factor_totals.setdefault(f["key"], {
                "key": f["key"], "label": f["label"], "unit": f["unit"],
                "why": f["why"], "saving_gbp": 0.0, "delta": 0, "routes": 0})
            acc["saving_gbp"] += f["saving_gbp"]
            acc["delta"] += f["delta"]
            acc["routes"] += 1
        for job in plan.get("jobs_needing_reallocation", []):
            reallocation.append({
                **job,
                "engineer_code": r["engineer_code"],
                "engineer_name": names.get(r["engineer_code"], r["engineer_code"])})

    factors = sorted(factor_totals.values(), key=lambda f: -abs(f["saving_gbp"]))
    for f in factors:
        f["saving_gbp"] = round(f["saving_gbp"], 2)
        f["delta"] = round(f["delta"], 1)

    top_routes = sorted(optimized, key=lambda r: r["mins_saved"], reverse=True)[:10]
    return ok({
        "routes_active": len(routes),
        "routes_optimized": len(optimized),
        "optimization_rate_pct": round(len(optimized) / len(routes) * 100, 1) if routes else 0,
        "miles_saved_today": total_miles_saved,
        "travel_mins_saved_today": total_mins_saved,
        "fuel_saved_today_gbp": fuel_saved_today,
        "fuel_saved_month_gbp": round(fuel_saved_today * WORKING_DAYS_PER_MONTH, 0),
        "co2_saved_today_kg": co2_saved_today,
        "ev_saving_month_gbp": ev_saving_month,
        "avg_mins_saved_per_route": round(total_mins_saved / len(optimized), 1) if optimized else 0,

        # The derivation, fleet-wide.
        "cost_baseline_gbp": round(cost_before, 2),
        "cost_optimised_gbp": round(cost_after, 2),
        "cost_saved_gbp": round(cost_before - cost_after, 2),
        "sla_jobs_protected": sla_jobs_protected,
        "sla_mins_recovered": sla_mins_recovered,
        "overtime_mins_saved": overtime_mins_saved,
        "caz_charges_avoided_gbp": round(caz_saved, 2),
        "factors": factors,
        "parts_readiness": parts_totals,
        "first_time_fix_at_risk": parts_totals.get("shortfall", 0),
        "jobs_needing_reallocation": reallocation[:25],
        "jobs_needing_reallocation_total": len(reallocation),
        "traffic_severity": state.get("traffic_severity", "normal"),

        "top_routes": [
            {
                "engineer_code": r["engineer_code"],
                "engineer_name": names.get(r["engineer_code"], r["engineer_code"]),
                "stops_total": r["stops_total"],
                "planned_travel_mins": r["planned_travel_mins"],
                "optimized_travel_mins": r["optimized_travel_mins"],
                "mins_saved": r["mins_saved"],
                "miles_saved": r["miles_saved"],
                "saving_gbp": (r.get("optimisation") or {}).get("saving_gbp", 0),
                "collections": len(r.get("collections", [])),
                "parts_summary": (r.get("optimisation") or {}).get("parts_summary", {}),
            }
            for r in top_routes
        ],
    })


@router.post("/routes/{engineer_code}/optimize")
async def optimize_route(
    engineer_code: str,
    apply: bool = Query(False, description="Commit the new sequence to the live round"),
    _: dict = Depends(require_any_permission("write:exception", "write:transfer", "write:playbook")),
):
    """Re-run the optimiser against where this van actually is, what is actually
    left on the round, and the traffic that is actually on the road right now.

    Returns the full derivation — baseline sequence, optimised sequence, the
    per-factor money delta and the binding constraints — so the answer can be
    read rather than trusted.
    """
    return ok(synthetic_state.reoptimise_round(engineer_code, apply=apply))


@router.get("/route-optimization/model")
async def get_optimization_model():
    """The factors the optimiser weighs and what each one is priced at.

    Published deliberately: a scheduling decision an operator cannot interrogate
    is one they will override, and the weights below are the whole argument.
    """
    return ok({
        "objective": "Minimise total round cost in £, subject to hard constraints",
        "hard_constraints": [
            {"key": "accreditation",
             "rule": "An engineer cannot be sequenced to a job whose required tickets they do not hold",
             "why": "Gas work without Gas Safe registration is an offence, not an inefficiency — "
                    "the job is pulled out for reallocation rather than priced and kept"},
            {"key": "parts_precedence",
             "rule": "A locker collection is sequenced before every job it supplies",
             "why": "You cannot fit a part you have not picked up"},
            {"key": "delivery_gate",
             "rule": "A job needing a bulky two-man delivery cannot start before that delivery lands",
             "why": "Heat pump outdoor units and pre-plumbed cylinders go direct to site, "
                    "not in the van and not in a locker"},
        ],
        "priced_factors": [
            {"key": "travel_labour", "label": "Travel time",
             "rate": f"£{routing.LABOUR_COST_PER_HOUR:.2f}/h loaded engineer cost",
             "why": "Time in the van is the largest controllable cost in a round"},
            {"key": "fuel", "label": "Distance",
             "rate": f"£{FUEL_PPM['diesel']:.2f}/mi diesel, £{FUEL_PPM['ev']:.2f}/mi EV",
             "why": "Fleet running rates; EV rounds are cheaper per mile so the optimiser "
                    "trades distance differently for them"},
            {"key": "sla_breach", "label": "SLA breach",
             "rate": " · ".join(
                 f"{p}: £{routing.SLA_BREACH_FIXED_GBP[p]:.0f} "
                 f"+ £{routing.SLA_BREACH_GBP_PER_MIN[p]:.2f}/min late"
                 for p in ("P1", "P2", "standard")),
             "why": "Ofgem Guaranteed Standards put supplier appointments in windows no longer "
                    "than four hours; an uncapped emergency is tighter still. Weighting P1 far "
                    "above a routine service is what makes the optimiser willing to detour"},
            {"key": "failed_first_time_fix", "label": "Failed first-time fix",
             "rate": f"£{routing.FAILED_FIRST_TIME_FIX_GBP:.0f} per job with no source for a critical part",
             "why": "The revisit is the expensive outcome: a second travel leg, a second "
                    "appointment slot and the rebooking. This is the term a distance-only "
                    "optimiser has no way to see"},
            {"key": "waiting", "label": "Waiting on a direct-to-site delivery",
             "rate": f"£{routing.IDLE_WAIT_GBP_PER_MIN * 60:.2f}/h",
             "why": "Cheaper than a revisit, but standing at a door is still paid time"},
            {"key": "clean_air_zone", "label": "Clean Air Zone charge",
             "rate": "Per-zone daily charge, applied once per zone entered",
             "why": "A non-compliant van clipping ULEZ or Glasgow LEZ is a real charge — "
                    "routing around the zone is often cheaper than driving through it"},
            {"key": "overtime", "label": "Overtime",
             "rate": f"£{routing.OVERTIME_COST_PER_HOUR:.2f}/h past {routing.to_hhmm(routing.SHIFT_END_MIN)}",
             "why": "Stops the optimiser pretending a 19:30 finish is free"},
        ],
        "travel_model": {
            "road_factor": routing.ROAD_FACTOR,
            "free_flow_mph": routing.BASE_MPH,
            "traffic_peak_uplift": routing.TRAFFIC_SEVERITY_PEAK,
            "why": "Crow-flies miles are not driving miles, and a 16:40 leg is not a 10:40 leg. "
                   "Travel time varies with both the live traffic severity and the hour the leg "
                   "is actually driven, which is why re-optimising mid-afternoon finds savings "
                   "the morning plan could not.",
        },
        "algorithm": {
            "seed": "Priority-aware nearest neighbour — a closing window outranks proximity",
            "improve": "2-opt (reverse a run) and Or-opt (relocate a 1–3 stop segment), "
                       "first-improvement, to convergence",
            "determinism": "No randomness. The same state always produces the same round, "
                           "which is what makes the saving figure defensible.",
            "guarantee": "If the optimiser cannot beat the booked order, the booked order stands.",
        },
        "skills": routing.SKILL_LABELS,
        "job_catalogue": [
            {"code": s.code, "label": s.label, "service_mins": s.service_mins,
             "priority": s.priority, "sla_slack_mins": s.sla_slack_mins,
             "required_skills": list(s.required_skills),
             "parts": [{"sku_code": p.sku_code, "description": p.description,
                        "handling": p.handling, "critical": p.critical} for p in s.parts]}
            for s in routing.JOB_SPECS.values()
        ],
    })


class WalkaroundRequest(BaseModel):
    completed_by: str


@router.post("/vehicles/{registration}/walkaround")
async def complete_walkaround(
    registration: str,
    req: WalkaroundRequest,
    _: dict = Depends(require_any_permission("write:exception", "write:transfer", "write:playbook")),
):
    return ok(synthetic_state.complete_walkaround(registration, req.completed_by))


class DefectResolveRequest(BaseModel):
    resolved_by: str


@router.put("/vehicles/{registration}/defects/{defect_id}/resolve")
async def resolve_defect(
    registration: str,
    defect_id: str,
    req: DefectResolveRequest,
    _: dict = Depends(require_any_permission("write:exception", "write:transfer", "write:playbook")),
):
    return ok(synthetic_state.resolve_vehicle_defect(registration, defect_id, req.resolved_by))


# ── Third-party carrier movements ───────────────────────────────────────────
# Not everything moves on our own vans. Small parts run hub → ByBox locker for
# pre-8AM collection or hub → engineer's boot overnight; anything bulky (heat
# pump outdoor units, pre-plumbed cylinders, full boiler swaps) cannot do either
# and is delivered two-man to the customer address on the day of the job. All
# three are third-party legs, all three can slip, and a slip on any of them is a
# job that will not complete.

_TRANSPORT_WRITE = require_any_permission("write:exception", "write:transfer", "write:playbook")


class ResolveRequest(BaseModel):
    action: str
    by: str
    params: dict | None = None


class BookMovementRequest(BaseModel):
    origin_code: str | None = None
    dest_type: str            # locker | in_boot | job_site
    dest_code: str
    service: str              # pre_8am | in_boot | same_day | next_day | two_man
    lines: list[dict]
    reason: str = "Manual booking"
    by: str = "dispatcher"
    linked_engineer_code: str | None = None
    linked_job_code: str | None = None


@router.get("/carrier-movements")
async def get_carrier_movements(
    status: str | None = Query(None, description="all | delayed | booked | collected | in_transit | out_for_delivery | delivered"),
    dest_type: str | None = Query(None, description="all | locker | in_boot | job_site"),
    with_options: bool = Query(True),
):
    rows = synthetic_state.carrier_movements(status=status, dest_type=dest_type,
                                             include_options=with_options)
    all_rows = synthetic_state.carrier_movements()
    live = [m for m in all_rows if m["status"] != "delivered"]
    delayed = [m for m in live if (m.get("delay_mins") or 0) > 0]
    return ok({
        "items": rows, "total": len(rows),
        "summary": {
            "in_flight": len(live),
            "delayed": len(delayed),
            "delivered": len([m for m in all_rows if m["status"] == "delivered"]),
            "bulky_in_flight": len([m for m in live if m["is_bulky"]]),
            "worst_delay_mins": max([m["delay_mins"] for m in delayed], default=0),
            "delay_cost_exposure_gbp": round(sum(m["cost_gbp"] for m in delayed), 2),
            "on_time_pct": round((len(live) - len(delayed)) / len(live) * 100, 1) if live else 100.0,
            "by_dest": {d: len([m for m in live if m["dest_type"] == d])
                        for d in ("locker", "in_boot", "job_site")},
        },
    })


@router.get("/carrier-movements/{movement_ref}")
async def get_carrier_movement(movement_ref: str):
    mv = next((m for m in synthetic_state.get_snapshot().get("carrier_movements", [])
               if m["movement_ref"] == movement_ref), None)
    if not mv:
        return ok({"error": "Movement not found"})
    return ok({**mv, "options": synthetic_state.carrier_options(mv)})


@router.post("/carrier-movements")
async def book_carrier_movement(req: BookMovementRequest, _: dict = Depends(_TRANSPORT_WRITE)):
    return ok(synthetic_state.book_carrier_movement(
        origin_code=req.origin_code, dest_type=req.dest_type, dest_code=req.dest_code,
        service=req.service, lines=req.lines, reason=req.reason, by=req.by,
        linked_engineer_code=req.linked_engineer_code, linked_job_code=req.linked_job_code))


@router.post("/carrier-movements/{movement_ref}/resolve")
async def resolve_carrier_movement(movement_ref: str, req: ResolveRequest,
                                   _: dict = Depends(_TRANSPORT_WRITE)):
    return ok(synthetic_state.resolve_carrier_movement(movement_ref, req.action, req.by, req.params))


# ── Arrival risk ────────────────────────────────────────────────────────────
# Engineers projected to miss one or more booked windows, with the courses of
# action a dispatcher actually has: re-optimise, reallocate, re-window the
# customer, defer a non-SLA stop, buy the time with overtime, or escalate.


@router.get("/eta-risk")
async def get_eta_risk(
    region: str | None = Query(None),
    with_options: bool = Query(True),
):
    rows = synthetic_state.eta_risks(region=region, include_options=with_options)
    open_rows = [r for r in rows if r["status"] == "open"]
    return ok({
        "items": rows, "total": len(rows),
        "summary": {
            "engineers_late": len(open_rows),
            "jobs_at_risk": sum(r["jobs_at_risk"] for r in open_rows),
            "sla_jobs_at_risk": sum(r["sla_jobs_at_risk"] for r in open_rows),
            "worst_breach_mins": max([r["worst_breach_mins"] for r in open_rows], default=0),
            "avg_delay_mins": round(sum(r["delay_mins"] for r in open_rows) / len(open_rows))
            if open_rows else 0,
            "by_cause": {c: len([r for r in open_rows if r["cause"] == c])
                         for c in {r["cause"] for r in open_rows}},
        },
    })


@router.post("/eta-risk/{engineer_code}/resolve")
async def resolve_eta_risk(engineer_code: str, req: ResolveRequest,
                           _: dict = Depends(_TRANSPORT_WRITE)):
    return ok(synthetic_state.resolve_eta_risk(engineer_code, req.action, req.by, req.params))


@router.get("/state-engine")
async def get_state_engine():
    """The update cadence the engine is running, per parameter family, plus any
    entity currently held against redraw because somebody acted on it."""
    return ok(synthetic_state.state_engine_status())
