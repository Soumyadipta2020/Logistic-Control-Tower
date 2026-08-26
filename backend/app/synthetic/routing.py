"""
Real-time route optimisation for a UK home-services field force.

What this replaces
------------------
The route generator used to decide savings with `random.random() < 0.7` and a
random 8–18% haircut. Nothing was optimised: an engineer with no gas
accreditation could be holding a boiler swap, a job needing a part nobody had
looked for scored the same as one whose parts were already in the van, and the
"miles saved" figure on the Transport page was a number with no cause.

This module computes the round instead. Every figure the UI shows can be traced
back to a factor, and every factor is one a UK dispatcher is actually held to.

The factors, and why each one is here
-------------------------------------
1. WORK REMAINING       Only uncompleted stops are sequenced, from the van's
                        live position and the current clock — not from the depot
                        at 08:00. Re-optimising at 14:20 is a different problem
                        to planning at 07:00.

2. JOB TYPE             Each type carries its own service time, priority, parts
                        list and accreditation requirement. An annual service and
                        a heat-pump install are not interchangeable stops.

3. ENGINEER SKILLS      Gas Safe / ACS-meter / SMETS2 / MCS / F-Gas / G3 / 18th
                        Edition. Gas work without Gas Safe registration is
                        illegal in the UK, not merely inefficient, so a skill gap
                        is a HARD constraint: the stop is pulled out for
                        reallocation rather than priced and kept.

4. PARTS AVAILABILITY   Resolved per stop against four real supply routes:
                          • van stock      — already aboard, no detour
                          • ByBox locker   — collection stop inserted into the
                                             round, costing a real detour
                          • direct-to-site — bulky items (heat-pump outdoor
                                             units, pre-plumbed cylinders) go
                                             two-man to the address; the engineer
                                             cannot start before that lands, so
                                             it opens a hard time window
                          • unavailable    — the visit will not fix it first
                                             time, and carries a revisit cost
                        This is the factor with the largest money attached and
                        the one a pure distance optimiser ignores completely.

5. LOCATION / TRAVEL    Great-circle miles × a UK road factor, then a traffic
                        multiplier that varies by scenario severity AND by time
                        of day — a 16:40 leg through Birmingham is not a 10:40
                        leg. Precedence is respected: a collection stop is always
                        sequenced before the job that needs it.

6. TIME WINDOWS / SLA   The customer's committed window does not move because we
                        added a detour. P1 emergency callouts price far above a
                        routine service, which is what makes the optimiser
                        willing to drive further to protect one.

7. CLEAN AIR ZONES      A non-compliant van clipping ULEZ / Birmingham / Glasgow
                        LEZ is a real daily charge. Routing a Euro-5 van around
                        the zone is often cheaper than driving through it.

8. DRIVERS' HOURS       Minutes past the shift end are priced as overtime, so the
                        optimiser stops pretending a 19:30 finish is free.

Everything is priced in pounds. That is deliberate: it makes the weights
arguable rather than magic, and it lets the UI answer "why did it choose this?"
with a number a depot manager recognises.

Leaf module — imports nothing from this package, so both `state.py` and
`resolutions.py` are free to import it.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

# ═════════════════════════════════════════════════════════════════════════════
# 1 · ACCREDITATIONS
# ═════════════════════════════════════════════════════════════════════════════
# The tickets a UK home-services engineer actually carries. These are not
# preferences the optimiser can trade away — working on a gas appliance without
# Gas Safe registration is an offence under the Gas Safety (Installation and
# Use) Regulations, so a missing ticket makes a stop infeasible, full stop.

SKILL_LABELS = {
    "gas_safe":       "Gas Safe registered (ACS core + appliance)",
    "acs_meter":      "ACS metering (MET1) — gas meter work",
    "smets2":         "SMETS2 smart-meter commissioning",
    "mcs_heat_pump":  "MCS-certified heat pump installation",
    "f_gas":          "F-Gas Cat 1 — sealed refrigerant circuits",
    "unvented_g3":    "G3 unvented hot water storage",
    "electrical_18th": "18th Edition / Part P electrical",
}


# ═════════════════════════════════════════════════════════════════════════════
# 2 · JOB CATALOGUE
# ═════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class PartReq:
    """One part a job type needs, and how it can physically reach the job.

    `handling` is the constraint that matters, not the price:
      van    — small, fast-moving, expected to live in the van
      locker — held at a ByBox forward stock location for pre-8AM collection
      bulky  — cannot go in a van or a locker; two-man delivery to the address
    """
    sku_code: str
    description: str
    qty: int = 1
    handling: str = "van"          # van | locker | bulky
    critical: bool = True          # without it, no first-time fix


@dataclass(frozen=True)
class JobSpec:
    code: str
    label: str
    service_mins: int
    priority: str                  # P1 | P2 | standard
    sla_slack_mins: int            # grace on the committed arrival window
    required_skills: tuple[str, ...]
    parts: tuple[PartReq, ...] = ()
    revenue_gbp: float = 0.0


# Ofgem's Guaranteed Standards put supplier appointments in slots no longer than
# four hours; an uncapped emergency (no heating / no hot water, vulnerable
# customer) is tighter still. The slack figures below are the grace on the
# committed arrival, which is what a breach is measured against.
JOB_SPECS: dict[str, JobSpec] = {
    "emergency_callout": JobSpec(
        "emergency_callout", "Emergency callout (no heat / no hot water)",
        service_mins=65, priority="P1", sla_slack_mins=15,
        required_skills=("gas_safe",),
        parts=(PartReq("SKU-BLR-004", "PCB Control Board", 1, "van"),
               PartReq("SKU-BLR-007", "Igniter Assembly", 1, "van")),
        revenue_gbp=240.0),

    "boiler_repair": JobSpec(
        "boiler_repair", "Boiler repair",
        service_mins=55, priority="P2", sla_slack_mins=30,
        required_skills=("gas_safe",),
        parts=(PartReq("SKU-BLR-001", "Diverter Valve", 1, "van"),
               PartReq("SKU-BLR-005", "Pressure Relief Valve", 1, "van")),
        revenue_gbp=185.0),

    "boiler_replacement": JobSpec(
        "boiler_replacement", "Boiler replacement",
        service_mins=280, priority="P2", sla_slack_mins=30,
        required_skills=("gas_safe", "unvented_g3"),
        parts=(PartReq("SKU-BLR-020", "Combi boiler unit", 1, "bulky"),
               PartReq("SKU-BLR-006", "Expansion Vessel", 1, "locker")),
        revenue_gbp=2400.0),

    "smart_meter_install": JobSpec(
        "smart_meter_install", "SMETS2 smart meter exchange",
        service_mins=75, priority="P2", sla_slack_mins=30,
        required_skills=("acs_meter", "smets2"),
        parts=(PartReq("SKU-SMT-001", "SMETS2 gas meter", 1, "locker"),
               PartReq("SKU-SMT-002", "Comms hub", 1, "locker")),
        revenue_gbp=160.0),

    "annual_service": JobSpec(
        "annual_service", "Annual boiler service",
        service_mins=45, priority="standard", sla_slack_mins=60,
        required_skills=("gas_safe",),
        parts=(PartReq("SKU-BLR-005", "Pressure Relief Valve", 1, "van",
                       critical=False),),
        revenue_gbp=95.0),

    "hive_install": JobSpec(
        "hive_install", "Hive thermostat install",
        service_mins=40, priority="standard", sla_slack_mins=60,
        required_skills=("electrical_18th",),
        parts=(PartReq("SKU-HIV-001", "Hive thermostat kit", 1, "van"),),
        revenue_gbp=110.0),

    "heat_pump_survey": JobSpec(
        "heat_pump_survey", "Heat pump technical survey",
        service_mins=50, priority="standard", sla_slack_mins=60,
        required_skills=("mcs_heat_pump",),
        parts=(), revenue_gbp=0.0),

    "heat_pump_install": JobSpec(
        "heat_pump_install", "Air source heat pump installation",
        service_mins=420, priority="P2", sla_slack_mins=30,
        required_skills=("mcs_heat_pump", "f_gas", "unvented_g3"),
        parts=(PartReq("SKU-ASHP-001", "ASHP outdoor unit 7kW", 1, "bulky"),
               PartReq("SKU-ASHP-002", "Pre-plumbed cylinder 210L", 1, "bulky"),
               PartReq("SKU-ASHP-010", "Commissioning kit", 1, "locker")),
        revenue_gbp=9800.0),

    "ev_charger_install": JobSpec(
        "ev_charger_install", "EV charge point installation",
        service_mins=180, priority="standard", sla_slack_mins=60,
        required_skills=("electrical_18th",),
        parts=(PartReq("SKU-EVC-001", "7kW charge point", 1, "locker"),),
        revenue_gbp=850.0),
}

# Anything the generator emits that predates the catalogue still has to price.
_FALLBACK_SPEC = JobSpec("unknown", "Unclassified visit", 50, "standard", 60,
                         required_skills=("gas_safe",))


def job_spec(job_type: str | None) -> JobSpec:
    return JOB_SPECS.get(job_type or "", _FALLBACK_SPEC)


# ═════════════════════════════════════════════════════════════════════════════
# 3 · TRAVEL MODEL
# ═════════════════════════════════════════════════════════════════════════════
# Crow-flies miles are not driving miles. 1.35 is the same road factor the rest
# of the codebase uses, so distances agree wherever they are quoted.

ROAD_FACTOR = 1.35
BASE_MPH = 28.0                    # UK mixed urban/A-road van average, free flow

# Scenario traffic severity → how much longer a leg takes at the WORST point of
# the day. Paired with the time-of-day profile below rather than applied flat,
# because "severe traffic" at 11:00 is still not a 17:30 problem.
TRAFFIC_SEVERITY_PEAK = {
    "normal":   0.30,
    "elevated": 0.45,
    "high":     0.65,
    "severe":   0.95,
}

# Share of the peak penalty in force, by hour. Two humps — the school/commuter
# run in and the evening peak out — with a genuinely quiet middle of the day.
_HOUR_PROFILE = {
    6: 0.35, 7: 0.85, 8: 1.00, 9: 0.75, 10: 0.35, 11: 0.25, 12: 0.30,
    13: 0.35, 14: 0.35, 15: 0.65, 16: 0.90, 17: 1.00, 18: 0.80, 19: 0.45,
}


def haversine_miles(lat1, lon1, lat2, lon2) -> float:
    if None in (lat1, lon1, lat2, lon2):
        return 0.0
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def road_miles(lat1, lon1, lat2, lon2) -> float:
    return haversine_miles(lat1, lon1, lat2, lon2) * ROAD_FACTOR


def traffic_multiplier(severity: str, minute_of_day: int) -> float:
    """1.0 = free flow. Depends on both the scenario severity and the hour the
    leg is actually driven, so a round that slips into the evening peak gets
    slower as it slips — which is precisely why re-optimising mid-afternoon
    finds savings a morning plan could not."""
    peak = TRAFFIC_SEVERITY_PEAK.get(severity, TRAFFIC_SEVERITY_PEAK["normal"])
    hour = max(0, min(23, minute_of_day // 60))
    return 1.0 + peak * _HOUR_PROFILE.get(hour, 0.20)


def travel_mins(miles: float, severity: str, depart_minute: int) -> int:
    return max(2, round(miles / BASE_MPH * 60 * traffic_multiplier(severity, depart_minute)))


# ═════════════════════════════════════════════════════════════════════════════
# 4 · CLEAN AIR ZONES
# ═════════════════════════════════════════════════════════════════════════════
# Single source of truth — the transport router imports this list so the map
# overlay and the routing cost can never disagree about where a zone is.
# radius_km is indicative for display, not a legal boundary.

CAZ_ZONES = [
    {"name": "London ULEZ",      "class": "ULEZ",    "latitude": 51.5074, "longitude": -0.1278, "radius_km": 22, "charges_vans": True, "daily_charge_gbp": 12.50, "hours": "24/7"},
    {"name": "Birmingham CAZ D", "class": "Class D", "latitude": 52.4862, "longitude": -1.8904, "radius_km": 3,  "charges_vans": True, "daily_charge_gbp": 8.00,  "hours": "24/7"},
    {"name": "Bristol CAZ D",    "class": "Class D", "latitude": 51.4545, "longitude": -2.5879, "radius_km": 3,  "charges_vans": True, "daily_charge_gbp": 9.00,  "hours": "24/7"},
    {"name": "Bath CAZ C",       "class": "Class C", "latitude": 51.3811, "longitude": -2.3590, "radius_km": 2,  "charges_vans": True, "daily_charge_gbp": 9.00,  "hours": "24/7"},
    {"name": "Sheffield CAZ C",  "class": "Class C", "latitude": 53.3811, "longitude": -1.4701, "radius_km": 3,  "charges_vans": True, "daily_charge_gbp": 10.00, "hours": "24/7"},
    {"name": "Bradford CAZ C",   "class": "Class C", "latitude": 53.7960, "longitude": -1.7594, "radius_km": 3,  "charges_vans": True, "daily_charge_gbp": 9.00,  "hours": "24/7"},
    {"name": "Newcastle CAZ C",  "class": "Class C", "latitude": 54.9783, "longitude": -1.6178, "radius_km": 2,  "charges_vans": True, "daily_charge_gbp": 12.50, "hours": "24/7"},
    {"name": "Glasgow LEZ",      "class": "LEZ",     "latitude": 55.8609, "longitude": -4.2514, "radius_km": 2,  "charges_vans": True, "daily_charge_gbp": 60.00, "hours": "24/7 (penalty)"},
]

_KM_PER_MILE = 1.60934


def zones_entered(points: list[tuple[float, float]]) -> list[dict]:
    """Which charging zones this set of stops sits inside. A daily charge is
    charged once however many times you cross it, so this is a set, not a count."""
    hit = {}
    for lat, lon in points:
        if lat is None or lon is None:
            continue
        for z in CAZ_ZONES:
            if z["name"] in hit:
                continue
            km = haversine_miles(lat, lon, z["latitude"], z["longitude"]) * _KM_PER_MILE
            if km <= z["radius_km"]:
                hit[z["name"]] = z
    return list(hit.values())


# ═════════════════════════════════════════════════════════════════════════════
# 5 · COST WEIGHTS
# ═════════════════════════════════════════════════════════════════════════════
# Everything below is in pounds, so the optimiser is comparing like with like
# and a dispatcher can argue with any single number without unpicking the model.

FUEL_PPM = {"diesel": 0.18, "ev": 0.07}   # pence per mile at fleet rates
DIESEL_CO2_KG_PER_MILE = 0.28

LABOUR_COST_PER_HOUR = 38.0        # loaded cost of an engineer's hour
OVERTIME_COST_PER_HOUR = 42.0      # matches the overtime option priced elsewhere

# A failed first-time fix is the expensive outcome in this business: the visit
# happens, the fault is diagnosed, the part is not there, and somebody drives
# back. Industry revisit cost for UK domestic heating sits around £120–£180 once
# travel, the second appointment slot and the rebooking admin are counted.
FAILED_FIRST_TIME_FIX_GBP = 145.0

# Breaching a committed window is priced per minute late, weighted by what was
# promised. A P1 emergency has a contractual clock and a vulnerable-customer
# risk behind it; a routine service that slips an hour has annoyed somebody but
# breached nothing contractual.
SLA_BREACH_GBP_PER_MIN = {"P1": 4.50, "P2": 1.80, "standard": 0.35}
SLA_BREACH_FIXED_GBP = {"P1": 60.0, "P2": 25.0, "standard": 5.0}

# Waiting at the door for a two-man delivery that has not landed yet is dead
# time — cheaper than a revisit, but not free.
IDLE_WAIT_GBP_PER_MIN = LABOUR_COST_PER_HOUR / 60

SHIFT_START_MIN = 8 * 60           # 08:00
SHIFT_END_MIN = 17 * 60            # 17:00 — past here is overtime
DRIVERS_HOURS_LIMIT_MIN = 10 * 60  # duty-day ceiling used for the feasibility flag

LOCKER_COLLECTION_MINS = 8         # park, authenticate, retrieve, back in the van
BULKY_UNLOAD_MINS = 15             # two-man drop signed for before work starts


# ═════════════════════════════════════════════════════════════════════════════
# 6 · CLOCK HELPERS
# ═════════════════════════════════════════════════════════════════════════════

def to_minutes(hhmm: str | None, default: int | None = None) -> int | None:
    if not hhmm or ":" not in str(hhmm):
        return default
    try:
        h, m = str(hhmm).split(":")[:2]
        return int(h) * 60 + int(m)
    except ValueError:
        return default


def to_hhmm(minute: int | None) -> str | None:
    if minute is None:
        return None
    minute = max(0, min(23 * 60 + 59, int(minute)))
    return f"{minute // 60:02d}:{minute % 60:02d}"


# ── What counts as still-to-be-driven ────────────────────────────────────────
# A stop leaves the drive sequence for three different reasons, and until this
# was written down the codebase asked `status != "completed"` in a dozen places
# and meant "still to drive" in all of them. That is fine while "completed" is
# the only terminal state and quietly wrong the moment it is not.
#
#   completed  worked, done
#   deferred   pushed to another day by a dispatcher's decision
#   blocked    cannot be worked by THIS engineer — no accreditation for it.
#              Still booked on the round, still needs reallocating, but the van
#              must not be routed to it and it must not raise an SLA breach
#              against an engineer who was never able to attend.

TERMINAL_STOP_STATUSES = ("completed", "deferred", "blocked")


def is_drivable(stop: dict) -> bool:
    """Will the van actually drive to this stop?"""
    return stop.get("status") not in TERMINAL_STOP_STATUSES


def drivable(stops: list[dict] | None) -> list[dict]:
    """The stops still ahead of the van, in order."""
    return [st for st in (stops or []) if is_drivable(st)]


# ═════════════════════════════════════════════════════════════════════════════
# 7 · SKILLS
# ═════════════════════════════════════════════════════════════════════════════

def engineer_skills(eng: dict) -> set[str]:
    """The tickets this engineer holds. Reads an explicit `skills` list when the
    generator has supplied one and otherwise falls back to the legacy boolean
    flags, so an older snapshot on disk still scores rather than crashing."""
    explicit = eng.get("skills")
    if explicit:
        return set(explicit)
    skills = {"gas_safe"}
    if eng.get("smet2_certified"):
        skills |= {"acs_meter", "smets2"}
    if eng.get("heat_pump_certified"):
        skills |= {"mcs_heat_pump", "f_gas"}
    return skills


def skill_gap(spec: JobSpec, skills: set[str]) -> list[str]:
    return [s for s in spec.required_skills if s not in skills]


# ═════════════════════════════════════════════════════════════════════════════
# 8 · PARTS READINESS
# ═════════════════════════════════════════════════════════════════════════════

@dataclass
class PartsPlan:
    """Where every part for one stop is coming from, and what that costs the
    round in detours and waiting."""
    status: str                       # ready | collect | await_delivery | shortfall
    ready: bool                       # can this visit fix it first time?
    lines: list[dict] = field(default_factory=list)
    locker: dict | None = None        # site to collect from, if any
    collect_skus: list[str] = field(default_factory=list)
    earliest_start_min: int | None = None   # bulky delivery ETA gate
    note: str = ""


def _van_qty(van_items: list[dict], sku: str) -> int:
    for it in van_items or []:
        if it.get("sku_code") == sku:
            return it.get("quantity") or 0
    return 0


def _usable(lk: dict) -> bool:
    """A site that missed its pre-8AM wave has nothing in it to collect, so it is
    not an option however close it is."""
    return bool(lk.get("pre_8am_delivered", True)) and (lk.get("items_available") or 0) > 0


def _nearest_locker(lockers: list[dict], lat, lon, region: str | None) -> dict | None:
    best, best_m = None, 1e9
    for lk in lockers or []:
        if region and lk.get("region") != region:
            continue
        if not _usable(lk):
            continue
        m = road_miles(lat, lon, lk.get("latitude"), lk.get("longitude"))
        if m < best_m:
            best, best_m = lk, m
    return best


def round_locker(lockers: list[dict], eng: dict, lat, lon) -> dict | None:
    """The ByBox site this round collects from.

    An engineer is assigned to a forward stock location and everything staged
    overnight lands there — they do not tour four lockers in a morning. So the
    assigned site wins whenever it received its wave, and only if it missed does
    the round fail over to the nearest healthy site.
    """
    assigned = eng.get("assigned_locker_code")
    if assigned:
        lk = next((l for l in lockers or [] if l.get("bybox_site_code") == assigned), None)
        if lk and _usable(lk):
            return lk
    return _nearest_locker(lockers, lat, lon, eng.get("region"))


def resolve_parts(stop: dict, eng: dict, lockers: list[dict],
                  deliveries: dict[str, dict] | None = None,
                  locker: dict | None = None,
                  collected: set[str] | None = None) -> PartsPlan:
    """Work out, per part, whether this visit can actually complete.

    Four supply routes, in the order a dispatcher would try them:
      van stock      → already aboard, nothing to do
      ByBox locker   → insert a collection stop, pay the detour
      direct-to-site → bulky two-man delivery; the job cannot start before it
      nothing        → the visit will not fix it first time
    """
    spec = job_spec(stop.get("job_type"))
    if not spec.parts:
        return PartsPlan(status="ready", ready=True, note="No parts required")

    van_items = eng.get("van_stock_items", [])
    deliveries = deliveries or {}
    lines, collect, worst_gate, ready = [], [], None, True
    # The round collects from ONE site. Resolved by the caller for the whole
    # round where possible, so a failover (assigned locker missed its pre-8AM
    # wave) sends the engineer to a single alternative rather than to a different
    # nearest-locker for every stop.
    chosen_locker = locker or round_locker(lockers, eng, stop.get("latitude"),
                                           stop.get("longitude"))

    for part in spec.parts:
        if part.handling == "bulky":
            # Cannot go in a van and will not fit a locker. It is delivered to
            # the customer's address, and the engineer waits if it is late.
            # Live carrier movement if one is booked, otherwise whatever the
            # stop itself carries — a snapshot reloaded from disk still knows
            # when its two-man drops are due.
            mv = (deliveries.get(f"{stop.get('job_code')}:{part.sku_code}")
                  or deliveries.get(stop.get("job_code") or "")
                  or stop.get("parts_delivery"))
            eta = to_minutes((mv or {}).get("eta")) if mv else None
            landed = bool(mv) and (mv or {}).get("status") == "delivered"
            if landed:
                src, ok = "direct_to_site", True
            elif mv:
                src, ok = "direct_to_site", True
                gate = (eta or SHIFT_START_MIN) + BULKY_UNLOAD_MINS
                worst_gate = gate if worst_gate is None else max(worst_gate, gate)
            else:
                src, ok = "not_booked", not part.critical
            lines.append({"sku_code": part.sku_code, "description": part.description,
                          "qty": part.qty, "handling": part.handling, "source": src,
                          "available": ok, "critical": part.critical,
                          "eta": to_hhmm(eta) if eta else None})
            ready = ready and ok
            continue

        # Already aboard — either it was stocked overnight, or the round has
        # already made the locker collection that carried it. Without the second
        # case a completed pickup counts for nothing and the optimiser orders the
        # same collection again on every re-run.
        if _van_qty(van_items, part.sku_code) >= part.qty or part.sku_code in (collected or ()):
            picked = part.sku_code in (collected or ())
            lines.append({"sku_code": part.sku_code, "description": part.description,
                          "qty": part.qty, "handling": part.handling,
                          "source": "collected" if picked else "van_stock",
                          "available": True, "critical": part.critical})
            continue

        # Not in the van — try the forward stock location.
        if chosen_locker:
            collect.append(part.sku_code)
            lines.append({"sku_code": part.sku_code, "description": part.description,
                          "qty": part.qty, "handling": part.handling,
                          "source": "locker", "available": True,
                          "critical": part.critical,
                          "locker_site": chosen_locker.get("bybox_site_code")})
        else:
            lines.append({"sku_code": part.sku_code, "description": part.description,
                          "qty": part.qty, "handling": part.handling,
                          "source": "unavailable", "available": not part.critical,
                          "critical": part.critical})
            ready = ready and not part.critical

    if not ready:
        missing = [ln["description"] for ln in lines if not ln["available"]]
        return PartsPlan(status="shortfall", ready=False, lines=lines,
                         earliest_start_min=worst_gate,
                         note=f"No source for {', '.join(missing)} — first-time fix at risk")

    if collect:
        return PartsPlan(status="collect", ready=True, lines=lines, locker=chosen_locker,
                         collect_skus=collect, earliest_start_min=worst_gate,
                         note=f"Collect {len(collect)} line(s) from "
                              f"{chosen_locker.get('bybox_site_code') if chosen_locker else 'locker'}")

    if worst_gate is not None:
        return PartsPlan(status="await_delivery", ready=True, lines=lines,
                         earliest_start_min=worst_gate,
                         note=f"Two-man delivery gates the start at {to_hhmm(worst_gate)}")

    return PartsPlan(status="ready", ready=True, lines=lines,
                     note="All parts in van stock")


# ═════════════════════════════════════════════════════════════════════════════
# 9 · ROUTE CONTEXT AND COST
# ═════════════════════════════════════════════════════════════════════════════

@dataclass
class Node:
    """One thing the van has to stop at — a customer job, or a locker collection
    inserted to serve one."""
    kind: str                       # job | collection
    ref: str                        # job_code, or the locker site code
    lat: float
    lon: float
    service_mins: int
    priority: str = "standard"
    job_type: str | None = None
    postcode: str | None = None
    deadline_min: int | None = None       # committed window + grace
    earliest_min: int | None = None       # cannot start before (bulky delivery)
    serves: list[str] = field(default_factory=list)   # collection → jobs it unblocks
    parts_ready: bool = True
    parts_status: str = "ready"
    parts_note: str = ""
    parts_lines: list[dict] = field(default_factory=list)
    source_stop: dict | None = None


@dataclass
class RouteContext:
    engineer_code: str
    start_lat: float
    start_lon: float
    start_min: int
    nodes: list[Node]
    severity: str = "normal"
    fuel_type: str = "diesel"
    caz_compliant: bool = True
    hours_driven_today: float = 0.0


@dataclass
class RouteCost:
    travel_miles: float = 0.0
    travel_mins: int = 0
    fuel_gbp: float = 0.0
    labour_gbp: float = 0.0
    sla_breach_gbp: float = 0.0
    sla_breach_mins: int = 0
    sla_jobs_breached: int = 0
    ftf_gbp: float = 0.0
    ftf_jobs_at_risk: int = 0
    idle_gbp: float = 0.0
    idle_mins: int = 0
    caz_gbp: float = 0.0
    caz_zones: list[str] = field(default_factory=list)
    overtime_gbp: float = 0.0
    overtime_mins: int = 0
    finish_min: int = 0
    total_gbp: float = 0.0
    schedule: list[dict] = field(default_factory=list)


def evaluate(order: list[Node], ctx: RouteContext) -> RouteCost:
    """Drive the sequence forward on the clock and price what happens.

    This is the objective function. Every term is a real cost a depot carries,
    which is why the optimiser will happily add three miles to protect a P1 and
    will not add thirty to protect a routine service.
    """
    cost = RouteCost()
    clock = ctx.start_min
    lat, lon = ctx.start_lat, ctx.start_lon
    ppm = FUEL_PPM.get(ctx.fuel_type, FUEL_PPM["diesel"])

    for node in order:
        miles = road_miles(lat, lon, node.lat, node.lon)
        mins = travel_mins(miles, ctx.severity, clock)
        cost.travel_miles += miles
        cost.travel_mins += mins
        arrive = clock + mins

        # A bulky two-man delivery that has not landed holds the engineer at the
        # door. Waiting is cheaper than a revisit, but it is still paid time.
        start = arrive
        if node.earliest_min is not None and start < node.earliest_min:
            wait = node.earliest_min - start
            cost.idle_mins += wait
            cost.idle_gbp += wait * IDLE_WAIT_GBP_PER_MIN
            start = node.earliest_min

        # The customer's committed window does not move because we detoured.
        breach = 0
        if node.kind == "job" and node.deadline_min is not None and start > node.deadline_min:
            breach = start - node.deadline_min
            cost.sla_breach_mins += breach
            cost.sla_jobs_breached += 1
            cost.sla_breach_gbp += (SLA_BREACH_FIXED_GBP.get(node.priority, 5.0)
                                    + breach * SLA_BREACH_GBP_PER_MIN.get(node.priority, 0.35))

        if node.kind == "job" and not node.parts_ready:
            cost.ftf_jobs_at_risk += 1
            cost.ftf_gbp += FAILED_FIRST_TIME_FIX_GBP

        depart = start + node.service_mins
        cost.schedule.append({
            "kind": node.kind, "ref": node.ref, "job_type": node.job_type,
            "postcode": node.postcode, "priority": node.priority,
            "latitude": node.lat, "longitude": node.lon,
            "travel_miles": round(miles, 1), "travel_mins": mins,
            "arrive": to_hhmm(arrive), "start": to_hhmm(start),
            "depart": to_hhmm(depart), "service_mins": node.service_mins,
            "deadline": to_hhmm(node.deadline_min),
            "breach_mins": breach,
            "parts_status": node.parts_status, "parts_ready": node.parts_ready,
            "parts_note": node.parts_note, "parts_lines": node.parts_lines,
            "serves": node.serves,
        })
        clock, lat, lon = depart, node.lat, node.lon

    cost.finish_min = clock
    cost.fuel_gbp = cost.travel_miles * ppm
    cost.labour_gbp = cost.travel_mins / 60 * LABOUR_COST_PER_HOUR

    if clock > SHIFT_END_MIN:
        cost.overtime_mins = clock - SHIFT_END_MIN
        cost.overtime_gbp = cost.overtime_mins / 60 * OVERTIME_COST_PER_HOUR

    if not ctx.caz_compliant:
        zones = zones_entered([(n.lat, n.lon) for n in order]
                              + [(ctx.start_lat, ctx.start_lon)])
        cost.caz_zones = [z["name"] for z in zones]
        cost.caz_gbp = sum(z["daily_charge_gbp"] for z in zones)

    cost.total_gbp = round(cost.fuel_gbp + cost.labour_gbp + cost.sla_breach_gbp
                           + cost.ftf_gbp + cost.idle_gbp + cost.caz_gbp
                           + cost.overtime_gbp, 2)
    return cost


# ═════════════════════════════════════════════════════════════════════════════
# 10 · THE OPTIMISER
# ═════════════════════════════════════════════════════════════════════════════
# Seed with a priority-aware nearest neighbour, then improve with 2-opt (reverse
# a run of stops) and Or-opt (relocate a short segment). Rounds are small — a UK
# domestic engineer does 2–8 stops — so this searches the neighbourhood
# exhaustively per pass and converges in a handful of passes. No randomness:
# the same state always produces the same round, which is what makes the saving
# figure defensible.


def _precedence_ok(order: list[Node]) -> bool:
    """A locker collection must come before every job it unblocks. Any candidate
    sequence that breaks that is not a route, whatever it costs."""
    job_at = {n.ref: i for i, n in enumerate(order) if n.kind == "job"}
    for i, n in enumerate(order):
        if n.kind != "collection":
            continue
        for served in n.serves:
            j = job_at.get(served)
            if j is not None and j < i:
                return False
    return True


def _seed_order(ctx: RouteContext) -> list[Node]:
    """Nearest neighbour, but a tight deadline outranks proximity — starting from
    the closest stop is a good heuristic for distance and a poor one for SLA."""
    remaining = list(ctx.nodes)
    order: list[Node] = []
    lat, lon, clock = ctx.start_lat, ctx.start_lon, ctx.start_min
    while remaining:
        def key(n: Node):
            miles = road_miles(lat, lon, n.lat, n.lon)
            slack = (n.deadline_min - clock) if n.deadline_min is not None else 600
            # Urgency dominates when a window is closing; distance decides the rest.
            return (0 if slack < 45 else 1, slack if slack < 45 else 0, miles)
        nxt = min(remaining, key=key)
        remaining.remove(nxt)
        clock += travel_mins(road_miles(lat, lon, nxt.lat, nxt.lon), ctx.severity, clock)
        clock = max(clock, nxt.earliest_min or 0) + nxt.service_mins
        order.append(nxt)
        lat, lon = nxt.lat, nxt.lon
    return _repair_precedence(order)


def _repair_precedence(order: list[Node]) -> list[Node]:
    """Pull every collection stop in front of the earliest job it serves."""
    out = list(order)
    for coll in [n for n in out if n.kind == "collection" and n.serves]:
        # Identity, not equality — Node is a value dataclass, so `.index()`
        # could match a different stop that happens to compare equal.
        ci = next(i for i, n in enumerate(out) if n is coll)
        targets = [i for i, n in enumerate(out)
                   if n.kind == "job" and n.ref in coll.serves]
        if targets and ci > min(targets):
            out.pop(ci)
            out.insert(min(targets), coll)
    return out


def optimise(ctx: RouteContext, *, max_passes: int = 8) -> tuple[list[Node], RouteCost]:
    order = _seed_order(ctx)
    best = evaluate(order, ctx)
    n = len(order)
    if n < 2:
        return order, best

    for _ in range(max_passes):
        improved = False

        # 2-opt: reverse a contiguous run. Fixes the crossed-path case.
        for i in range(n - 1):
            for j in range(i + 2, n + 1):
                cand = order[:i] + order[i:j][::-1] + order[j:]
                if not _precedence_ok(cand):
                    continue
                c = evaluate(cand, ctx)
                if c.total_gbp < best.total_gbp - 0.01:
                    order, best, improved = cand, c, True

        # Or-opt: lift a 1–3 stop segment and drop it somewhere better. This is
        # the move that pulls a P1 forward without shredding the rest of the day.
        for seg in (1, 2, 3):
            for i in range(n - seg + 1):
                chunk = order[i:i + seg]
                rest = order[:i] + order[i + seg:]
                for j in range(len(rest) + 1):
                    if j == i:
                        continue
                    cand = rest[:j] + chunk + rest[j:]
                    if not _precedence_ok(cand):
                        continue
                    c = evaluate(cand, ctx)
                    if c.total_gbp < best.total_gbp - 0.01:
                        order, best, improved = cand, c, True

        if not improved:
            break

    return order, best


# ═════════════════════════════════════════════════════════════════════════════
# 11 · BUILDING A ROUTE FROM LIVE STATE
# ═════════════════════════════════════════════════════════════════════════════

def build_nodes(stops: list[dict], eng: dict, lockers: list[dict],
                deliveries: dict[str, dict] | None = None,
                collected: set[str] | None = None) -> tuple[list[Node], list[dict]]:
    """Turn the remaining stops into optimiser nodes, resolving skills and parts.

    Returns (feasible nodes, infeasible stops). A stop is infeasible when the
    engineer does not hold the accreditation it requires — that is not a cost to
    price, it is a job somebody else has to do, so it comes back separately for
    the dispatcher to reallocate.
    """
    skills = engineer_skills(eng)
    nodes: list[Node] = []
    infeasible: list[dict] = []
    collect_needs: dict[str, PartsPlan] = {}

    # One forward stock location for the whole round, anchored on the work rather
    # than on any single stop.
    pts = [(st.get("latitude"), st.get("longitude")) for st in stops
           if st.get("latitude") is not None]
    anchor = ((sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
              if pts else (eng.get("latitude"), eng.get("longitude")))
    site = round_locker(lockers, eng, anchor[0], anchor[1])

    for st in stops:
        spec = job_spec(st.get("job_type"))
        gap = skill_gap(spec, skills)
        if gap:
            infeasible.append({
                **{k: st.get(k) for k in ("seq", "job_code", "job_type", "postcode",
                                          "priority", "planned_arrival", "sla_deadline",
                                          "latitude", "longitude")},
                "reason": "skill_gap",
                "missing_skills": gap,
                "missing_skill_labels": [SKILL_LABELS.get(g, g) for g in gap],
            })
            continue

        plan = resolve_parts(st, eng, lockers, deliveries, locker=site, collected=collected)
        deadline = to_minutes(st.get("sla_deadline")) or (
            (to_minutes(st.get("planned_arrival")) or SHIFT_START_MIN) + spec.sla_slack_mins)

        job_node = Node(
            kind="job", ref=st.get("job_code") or f"STOP-{st.get('seq')}",
            lat=st.get("latitude"), lon=st.get("longitude"),
            service_mins=st.get("service_mins") or spec.service_mins,
            priority=st.get("priority") or spec.priority,
            job_type=st.get("job_type"), postcode=st.get("postcode"),
            deadline_min=deadline, earliest_min=plan.earliest_start_min,
            parts_ready=plan.ready, parts_status=plan.status,
            parts_note=plan.note, parts_lines=plan.lines, source_stop=st)
        nodes.append(job_node)
        if plan.status == "collect" and plan.locker:
            collect_needs[job_node.ref] = plan

    # A locker collection is a real stop with a real detour, so it is sequenced
    # by the optimiser rather than assumed away. But nobody drives to the same
    # ByBox site twice in a morning: every line due from one site is picked up in
    # a single visit, which is what an engineer actually does and what stops the
    # optimiser inventing detours that would never be driven.
    by_site: dict[str, list[str]] = {}
    site_plan: dict[str, PartsPlan] = {}
    for job_ref, plan in collect_needs.items():
        site = plan.locker.get("bybox_site_code")
        by_site.setdefault(site, []).append(job_ref)
        site_plan.setdefault(site, plan)

    for site, served in by_site.items():
        plan = site_plan[site]
        skus = sorted({s for r in served for s in collect_needs[r].collect_skus})
        lines = [ln for r in served for ln in collect_needs[r].lines
                 if ln.get("source") == "locker"]
        nodes.append(Node(
            kind="collection", ref=site,
            lat=plan.locker.get("latitude"), lon=plan.locker.get("longitude"),
            # One authentication and park-up, then a minute per additional line.
            service_mins=LOCKER_COLLECTION_MINS + max(0, len(skus) - 1),
            postcode=plan.locker.get("postcode"),
            serves=served, parts_status="collect",
            parts_note=f"Collect {len(skus)} line(s) for {len(served)} job(s)",
            parts_lines=lines))

    return nodes, infeasible


def _baseline_order(nodes: list[Node], stops: list[dict]) -> list[Node]:
    """The as-dispatched round: stops in the sequence they were booked, with any
    collection immediately before the job that needs it. This is what the day
    looks like WITHOUT the optimiser, and it is the honest comparison — measuring
    savings against a randomly shuffled route would flatter the result."""
    seq = {st.get("job_code"): i for i, st in enumerate(stops)}
    jobs = sorted([n for n in nodes if n.kind == "job"],
                  key=lambda n: seq.get(n.ref, 999))
    colls = [n for n in nodes if n.kind == "collection"]
    out: list[Node] = []
    for j in jobs:
        # The collection lands immediately before the first job it serves —
        # the un-optimised thing to do, which is the point of the baseline.
        for c in [c for c in colls if j.ref in c.serves]:
            out.append(c)
            colls.remove(c)
        out.append(j)
    return out + colls


def optimise_round(*, engineer: dict, route: dict, lockers: list[dict],
                   severity: str = "normal", fuel_type: str = "diesel",
                   caz_compliant: bool = True, hours_driven_today: float = 0.0,
                   now_min: int | None = None,
                   deliveries: dict[str, dict] | None = None,
                   collected: set[str] | None = None) -> dict:
    """Optimise one engineer's remaining round and explain the result.

    The return value is the whole story: the baseline it was measured against,
    the optimised sequence, the per-factor money delta, and the constraints that
    bound the answer. The UI does not have to recompute anything to say why.
    """
    stops = [st for st in route.get("stops", []) if st.get("status") != "completed"]
    nodes, infeasible = build_nodes(stops, engineer, lockers, deliveries, collected)

    start_min = now_min if now_min is not None else (
        to_minutes((stops[0] or {}).get("planned_arrival"), SHIFT_START_MIN)
        if stops else SHIFT_START_MIN)

    ctx = RouteContext(
        engineer_code=engineer.get("engineer_code"),
        start_lat=engineer.get("latitude"), start_lon=engineer.get("longitude"),
        start_min=start_min, nodes=nodes, severity=severity, fuel_type=fuel_type,
        caz_compliant=caz_compliant, hours_driven_today=hours_driven_today)

    if not nodes:
        empty = RouteCost()
        return _result(ctx, [], empty, [], empty, infeasible)

    base_order = _baseline_order(nodes, stops)
    base_cost = evaluate(base_order, ctx)
    best_order, best_cost = optimise(ctx)

    # The optimiser must never be allowed to make things worse: if the seeded
    # search cannot beat the booked order, the booked order stands.
    if base_cost.total_gbp <= best_cost.total_gbp:
        best_order, best_cost = base_order, base_cost

    return _result(ctx, best_order, best_cost, base_order, base_cost, infeasible)


def _result(ctx: RouteContext, order: list[Node], cost: RouteCost,
            base_order: list[Node], base: RouteCost, infeasible: list[dict]) -> dict:
    """Assemble the answer, including the per-factor attribution that lets the
    Transport page show WHY rather than just how much."""
    ppm = FUEL_PPM.get(ctx.fuel_type, FUEL_PPM["diesel"])
    co2_saved = ((base.travel_miles - cost.travel_miles) * DIESEL_CO2_KG_PER_MILE
                 if ctx.fuel_type == "diesel" else 0.0)

    factors = [
        _factor("travel_time", "Travel time", "min",
                base.travel_mins, cost.travel_mins,
                base.labour_gbp, cost.labour_gbp,
                "Re-sequenced against live traffic and time-of-day road speeds"),
        _factor("distance", "Distance", "mi",
                round(base.travel_miles, 1), round(cost.travel_miles, 1),
                base.fuel_gbp, cost.fuel_gbp,
                "Fewer miles between stops at fleet fuel rates"),
        _factor("sla", "SLA breach exposure", "min late",
                base.sla_breach_mins, cost.sla_breach_mins,
                base.sla_breach_gbp, cost.sla_breach_gbp,
                "Committed customer windows protected, weighted P1 > P2 > standard"),
        _factor("first_time_fix", "First-time-fix risk", "jobs",
                base.ftf_jobs_at_risk, cost.ftf_jobs_at_risk,
                base.ftf_gbp, cost.ftf_gbp,
                "Jobs whose parts have no source — each one is a revisit"),
        _factor("parts_wait", "Waiting on direct-to-site delivery", "min",
                base.idle_mins, cost.idle_mins,
                base.idle_gbp, cost.idle_gbp,
                "Bulky two-man drops gate the start; the round works around them"),
        _factor("clean_air_zones", "Clean Air Zone charges", "zones",
                len(base.caz_zones), len(cost.caz_zones),
                base.caz_gbp, cost.caz_gbp,
                "Non-compliant van routed around charging zones where possible"),
        _factor("overtime", "Overtime", "min",
                base.overtime_mins, cost.overtime_mins,
                base.overtime_gbp, cost.overtime_gbp,
                "Minutes past the shift end, priced at the overtime rate"),
    ]

    parts_summary = {"ready": 0, "collect": 0, "await_delivery": 0, "shortfall": 0}
    for n in order:
        if n.kind == "job":
            parts_summary[n.parts_status] = parts_summary.get(n.parts_status, 0) + 1

    return {
        "engineer_code": ctx.engineer_code,
        "applied": cost.total_gbp < base.total_gbp - 0.01,
        "traffic_severity": ctx.severity,
        "start_at": to_hhmm(ctx.start_min),

        "baseline": _summary(base, base_order),
        "optimised": _summary(cost, order),

        "saving_gbp": round(base.total_gbp - cost.total_gbp, 2),
        "miles_saved": round(base.travel_miles - cost.travel_miles, 1),
        "mins_saved": base.travel_mins - cost.travel_mins,
        "fuel_saved_gbp": round((base.travel_miles - cost.travel_miles) * ppm, 2),
        "co2_saved_kg": round(co2_saved, 1),
        "sla_mins_recovered": base.sla_breach_mins - cost.sla_breach_mins,
        "sla_jobs_protected": base.sla_jobs_breached - cost.sla_jobs_breached,

        "factors": [f for f in factors if f["baseline"] or f["optimised"]],
        "sequence": cost.schedule,
        "parts_summary": parts_summary,
        "jobs_needing_reallocation": infeasible,
        "constraints": {
            "shift_end": to_hhmm(SHIFT_END_MIN),
            "projected_finish": to_hhmm(cost.finish_min),
            "overtime_mins": cost.overtime_mins,
            "drivers_hours_used_h": round(ctx.hours_driven_today + cost.travel_mins / 60, 1),
            "drivers_hours_breach": (ctx.hours_driven_today * 60 + cost.travel_mins)
                                    > DRIVERS_HOURS_LIMIT_MIN,
            "caz_compliant_van": ctx.caz_compliant,
            "caz_zones_on_round": cost.caz_zones,
        },
    }


def _summary(cost: RouteCost, order: list[Node]) -> dict:
    return {
        "stops": len([n for n in order if n.kind == "job"]),
        "collections": len([n for n in order if n.kind == "collection"]),
        "travel_miles": round(cost.travel_miles, 1),
        "travel_mins": cost.travel_mins,
        "finish_at": to_hhmm(cost.finish_min),
        "sla_jobs_breached": cost.sla_jobs_breached,
        "sla_breach_mins": cost.sla_breach_mins,
        "ftf_jobs_at_risk": cost.ftf_jobs_at_risk,
        "cost_gbp": round(cost.total_gbp, 2),
        "cost_breakdown": {
            "fuel": round(cost.fuel_gbp, 2),
            "travel_labour": round(cost.labour_gbp, 2),
            "sla_breach": round(cost.sla_breach_gbp, 2),
            "failed_first_time_fix": round(cost.ftf_gbp, 2),
            "waiting": round(cost.idle_gbp, 2),
            "clean_air_zone": round(cost.caz_gbp, 2),
            "overtime": round(cost.overtime_gbp, 2),
        },
        "order": [{"kind": n.kind, "ref": n.ref, "priority": n.priority,
                   "job_type": n.job_type, "postcode": n.postcode} for n in order],
    }


def _factor(key: str, label: str, unit: str, before, after,
            before_gbp: float, after_gbp: float, why: str) -> dict:
    return {
        "key": key, "label": label, "unit": unit,
        "baseline": before, "optimised": after,
        "delta": round((before - after), 1) if isinstance(before, float) else before - after,
        "saving_gbp": round(before_gbp - after_gbp, 2),
        "why": why,
    }
