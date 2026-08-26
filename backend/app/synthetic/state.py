"""
Central in-memory synthetic state engine for CLT demo mode.
Initialises once on startup; background ticker refreshes stochastic values every 60s.
All API routers read from this single source of truth.

Persistence: the baseline snapshot is written to data/synthetic_snapshot.json on
first generation and reloaded on every subsequent startup.  Only regenerate when
the file is missing (or force_regenerate() is called explicitly).
"""
import json
import logging
import math
import os
import random
import threading
import time
import uuid
from datetime import datetime, timezone, timedelta, date
from pathlib import Path
from typing import Any

# The catalog of every user-performable action and its governance policy. The
# per-action autonomy thresholds the agent engine enforces are DERIVED from it,
# so policy is edited in exactly one place (app/synthetic/actions.py) and the
# Governance tab renders the same rows the engine evaluates.
from app.synthetic.actions import (  # noqa: F401  (re-exported for the agent engine)
    ACTION_CATALOG, ACTION_BY_KEY, ACTION_BY_THRESHOLD, ACTION_THRESHOLDS,
    MODULES as ACTION_MODULES, AUTONOMY_CLASSES, CATEGORIES as ACTION_CATEGORIES,
    catalog_summary,
)

# The route optimiser. Also leaf-level, so it can be read from here and from the
# resolution engine without an import cycle. Every "miles saved" / "minutes
# saved" figure in Transport Control is computed by this module against the real
# constraints (skills, parts, traffic, SLA windows, clean air zones, drivers'
# hours) rather than drawn from a distribution.
from app.synthetic import routing
from app.synthetic.routing import JOB_SPECS, SKILL_LABELS  # noqa: F401
# Per-family update cadence + the "hold" that stops a random redraw from erasing
# the effect of an action a human (or ATLAS) just took.
from app.synthetic import cadence as CAD
# The four operational failure modes and everything an operator can do about
# them: van stock alerts, pre-8AM locker misses, third-party carrier legs and
# arrival risk. Mixed into SyntheticState below.
from app.synthetic.resolutions import ResolutionMixin, add_mins as _add_clock_mins

_log = logging.getLogger("clt.synthetic")

# Ordering used when the AI-ON variation decides what it may execute alone:
# lower is more severe, so an action clears its ceiling when rank >= ceiling rank.
SEV_RANK_AI = {"critical": 0, "high": 1, "medium": 2, "low": 3, "opportunity": 4}
# The global spend guardrail the AI-ON variation reasons against. The live value
# is owned by the agent engine (operators can move it on the Governance tab);
# this is the default the state engine assumes when it models the response.
AI_AUTO_APPROVE_GBP = 25_000

# Resolve path relative to this file: backend/data/synthetic_snapshot.json
_HERE = Path(__file__).resolve().parent          # …/backend/app/synthetic/
_DATA_DIR = _HERE.parent.parent / "data"         # …/backend/data/
SNAPSHOT_PATH = _DATA_DIR / "synthetic_snapshot.json"


UK_REGIONS = [
    "East Midlands", "West Midlands", "South East", "South West",
    "North West", "North East", "Yorkshire", "East of England",
    "London", "Wales", "Scotland", "Northern Ireland",
]

BOILER_BRANDS = ["Vaillant", "Navien", "Ideal Logic", "Worcester Bosch", "Baxi", "Potterton", "Vokèra"]
BOILER_MODELS = {
    "Vaillant": ["ecoTEC Plus 30", "ecoTEC Plus 35", "ecoFIT Pure 29", "aroTHERM Plus 7"],
    "Navien": ["NCB-E 28kW", "NCB-E 35kW", "NHB-28", "NPE-32A"],
    "Ideal Logic": ["Combi C30", "Heat H15", "System S30", "Max 30"],
    "Worcester Bosch": ["Greenstar 25i", "Greenstar 30i", "Greenstar 8000"],
}
FAULT_TYPES = [
    "diverter_valve_failure", "heat_exchanger_degradation",
    "fan_motor_anomaly", "ignition_fault", "pcb_fault",
]
# The part that actually clears each fault. This is the join that turns a Hive
# telemetry signal into a supply-chain decision: a fault we can predict but have
# no part for is not a saved job, it is a wasted visit. Every SKU here is one the
# vans already carry (see _gen_van_stock_items), so cover can be read off the
# real network rather than invented.
FAULT_PART_MAP = {
    "diverter_valve_failure":     ("SKU-BLR-001", "Diverter Valve - Vaillant ecoTEC"),
    "heat_exchanger_degradation": ("SKU-BLR-002", "Heat Exchanger - Navien NCB-E"),
    "fan_motor_anomaly":          ("SKU-BLR-003", "Fan Motor Assembly"),
    "pcb_fault":                  ("SKU-BLR-004", "PCB Control Board"),
    "ignition_fault":             ("SKU-BLR-007", "Igniter Assembly"),
}
ENGINEER_BU = ["british_gas", "dyno", "ph_jones", "hive"]
WAREHOUSES_DATA = [
    {"code": "LEI_COE", "name": "Leicester NDC", "type": "primary_coe", "operator": "TVS SCS",
     "latitude": 52.6369, "longitude": -1.1398, "baseline_items_per_hour": 3500, "is_primary": True},
    {"code": "COV_HUB", "name": "Coventry Regional Hub", "type": "secondary_hub", "operator": "TVS SCS",
     "latitude": 52.4068, "longitude": -1.5197, "baseline_items_per_hour": 2000, "is_primary": False},
    {"code": "MAN_HUB", "name": "Manchester Regional Hub", "type": "secondary_hub", "operator": "TVS SCS",
     "latitude": 53.4808, "longitude": -2.2426, "baseline_items_per_hour": 1200, "is_primary": False},
    {"code": "CAR_HUB", "name": "Cardiff Regional Hub", "type": "secondary_hub", "operator": "TVS SCS",
     "latitude": 51.4816, "longitude": -3.1791, "baseline_items_per_hour": 800, "is_primary": False},
]

# ── Two-echelon distribution network (DRP model) ─────────────────────────────
# Parts flow: Suppliers → Leicester NDC (national distribution centre) →
# regional hubs via internal stock transfers. Supplier POs always land at the
# NDC; hubs never order from suppliers directly.
NDC_CODE = "LEI_COE"
HUB_CODES = ["COV_HUB", "MAN_HUB", "CAR_HUB"]
# Trunker transfer lead time NDC → hub (days) and hub review cadence (days).
HUB_TRANSFER_LEAD_DAYS = {"COV_HUB": 1, "MAN_HUB": 1, "CAR_HUB": 2}
HUB_REVIEW_DAYS = 2
# Share of network stock and daily demand served from each site, by category.
# The NDC holds the strategic buffer (and absorbs rounding remainders); hubs
# hold forward stock sized to their regional demand.
WAREHOUSE_ALLOCATION = {
    "boiler":      {"LEI_COE": 0.46, "COV_HUB": 0.22, "MAN_HUB": 0.20, "CAR_HUB": 0.12},
    "heat_pump":   {"LEI_COE": 0.70, "COV_HUB": 0.12, "MAN_HUB": 0.12, "CAR_HUB": 0.06},
    "smart_meter": {"LEI_COE": 0.50, "COV_HUB": 0.18, "MAN_HUB": 0.20, "CAR_HUB": 0.12},
    "ev_charger":  {"LEI_COE": 0.58, "COV_HUB": 0.16, "MAN_HUB": 0.14, "CAR_HUB": 0.12},
}
_DEFAULT_ALLOCATION = {"LEI_COE": 0.55, "COV_HUB": 0.17, "MAN_HUB": 0.16, "CAR_HUB": 0.12}
SUPPLIER_DATA = [
    {"supplier_code": "VAI_UK", "name": "Vaillant UK Ltd", "category": "boiler_oem", "country_code": "GB", "is_tier1": True, "otif_base": 95},
    {"supplier_code": "NAV_UK", "name": "Navien UK", "category": "boiler_oem", "country_code": "GB", "is_tier1": True, "otif_base": 94},
    {"supplier_code": "MIT_HV", "name": "Mitsubishi HVAC", "category": "heat_pump", "country_code": "JP", "is_tier1": True, "otif_base": 82},
    {"supplier_code": "DAI_EU", "name": "Daikin Europe NV", "category": "heat_pump", "country_code": "BE", "is_tier1": True, "otif_base": 91},
    {"supplier_code": "SAM_HA", "name": "Samsung HA UK", "category": "heat_pump", "country_code": "KR", "is_tier1": True, "otif_base": 65},
    {"supplier_code": "ALF_NL", "name": "Alfen NL", "category": "ev_charger", "country_code": "NL", "is_tier1": True, "otif_base": 88},
    {"supplier_code": "SYN_UK", "name": "Sync Energy", "category": "ev_charger", "country_code": "GB", "is_tier1": False, "otif_base": 86},
    {"supplier_code": "WOL_UK", "name": "Wolseley UK / HTS", "category": "trade_merchant", "country_code": "GB", "is_tier1": True, "otif_base": 92},
    {"supplier_code": "LAND_UK", "name": "Landis+Gyr", "category": "smart_meter", "country_code": "CH", "is_tier1": True, "otif_base": 90},
    {"supplier_code": "ITE_UK", "name": "Itron UK", "category": "smart_meter", "country_code": "GB", "is_tier1": True, "otif_base": 89},
]

# unit_cost_gbp feeds working-capital / value-at-risk analytics; demand_cv is the
# coefficient of variation of weekly demand and drives the XYZ (predictability)
# classification — X ≤ 0.25 stable, Y ≤ 0.5 variable, Z > 0.5 volatile.
SKU_CONFIG = {
    "SKU-BLR-001": {"daily_consumption": 42,  "safety_stock": 252, "lead_time_days": 3,   "review_period_days": 7,  "unit_cost_gbp": 38,   "demand_cv": 0.45},
    "SKU-BLR-002": {"daily_consumption": 28,  "safety_stock": 140, "lead_time_days": 5,   "review_period_days": 7,  "unit_cost_gbp": 185,  "demand_cv": 0.40},
    "SKU-BLR-003": {"daily_consumption": 18,  "safety_stock":  90, "lead_time_days": 4,   "review_period_days": 7,  "unit_cost_gbp": 96,   "demand_cv": 0.35},
    "SKU-BLR-004": {"daily_consumption": 12,  "safety_stock":  84, "lead_time_days": 5,   "review_period_days": 14, "unit_cost_gbp": 142,  "demand_cv": 0.55},
    "SKU-BLR-005": {"daily_consumption": 85,  "safety_stock": 340, "lead_time_days": 2,   "review_period_days": 7,  "unit_cost_gbp": 12,   "demand_cv": 0.30},
    "SKU-HP-001":  {"daily_consumption":  8,  "safety_stock":  80, "lead_time_days": 98,  "review_period_days": 14, "unit_cost_gbp": 3200, "demand_cv": 0.60},
    "SKU-HP-002":  {"daily_consumption":  6,  "safety_stock":  60, "lead_time_days": 112, "review_period_days": 14, "unit_cost_gbp": 3400, "demand_cv": 0.65},
    "SKU-SM-001":  {"daily_consumption": 32,  "safety_stock": 160, "lead_time_days": 7,   "review_period_days": 7,  "unit_cost_gbp": 58,   "demand_cv": 0.15},
    "SKU-EV-001":  {"daily_consumption": 14,  "safety_stock":  98, "lead_time_days": 21,  "review_period_days": 14, "unit_cost_gbp": 520,  "demand_cv": 0.48},
}

SKU_CATEGORY = {
    "SKU-BLR-001": "boiler", "SKU-BLR-002": "boiler", "SKU-BLR-003": "boiler",
    "SKU-BLR-004": "boiler", "SKU-BLR-005": "boiler",
    "SKU-HP-001": "heat_pump", "SKU-HP-002": "heat_pump",
    "SKU-SM-001": "smart_meter", "SKU-EV-001": "ev_charger",
}

# SKU → preferred supplier for automatic replenishment. Module-level so the
# planning-policy engine can weight lead-time variability by supplier reliability.
SKU_PRIMARY_SUPPLIER = {
    "SKU-BLR-001": "VAI_UK", "SKU-BLR-002": "NAV_UK", "SKU-BLR-003": "VAI_UK",
    "SKU-BLR-004": "WOL_UK", "SKU-BLR-005": "WOL_UK",
    "SKU-HP-001": "MIT_HV", "SKU-HP-002": "DAI_EU",
    "SKU-SM-001": "LAND_UK", "SKU-EV-001": "ALF_NL",
}

# Curated "hero" SKUs carry the demo storyline; the rest of the catalogue is a
# generated long tail so the module is exercised at realistic scale.
SKU_DESCRIPTION = {
    "SKU-BLR-001": "Diverter Valve - Vaillant ecoTEC",
    "SKU-BLR-002": "Heat Exchanger - Navien NCB-E",
    "SKU-BLR-003": "Fan Motor Assembly",
    "SKU-BLR-004": "PCB Control Board Universal",
    "SKU-BLR-005": "Pressure Relief Valve 3 bar",
    "SKU-HP-001":  "Mitsubishi Ecodan 7kW Kit",
    "SKU-HP-002":  "Daikin Altherma 8kW Kit",
    "SKU-SM-001":  "SMET2 Dual Fuel Meter Kit BG",
    "SKU-EV-001":  "Alfen Eve Pro 22kW Charger",
}
CURATED_SKUS = tuple(SKU_DESCRIPTION.keys())

# Total catalogue size — override with CLT_SKU_COUNT to dial the long tail up or
# down. The page is designed to stay usable at 1000+ because every list is
# paged/filtered server-side and every aggregate is computed server-side.
SKU_CATALOGUE_SIZE = max(len(CURATED_SKUS), int(os.getenv("CLT_SKU_COUNT", "1200")))

_CAT_PREFIX = {"boiler": "BLR", "heat_pump": "HP", "smart_meter": "SM", "ev_charger": "EV"}
_PART_FAMILIES = {
    "boiler": [
        ("Diverter Valve", 34, 62), ("Heat Exchanger", 140, 240), ("Fan Motor Assembly", 70, 130),
        ("PCB Control Board", 95, 190), ("Pressure Relief Valve", 8, 22), ("Expansion Vessel", 40, 85),
        ("Pump Head", 60, 120), ("Gas Valve", 85, 165), ("Flue Kit", 45, 95),
        ("Thermistor Probe", 6, 18), ("Ignition Electrode", 9, 26), ("Condensate Trap", 12, 30),
        ("Filling Loop", 10, 24), ("Auto Air Vent", 7, 19), ("Flow Sensor", 18, 44),
        ("Pressure Gauge", 11, 27), ("Burner Assembly", 110, 210), ("Overheat Thermostat", 15, 38),
    ],
    "heat_pump": [
        ("Monobloc Unit 7kW", 2800, 3600), ("Cylinder 210L", 900, 1400), ("Buffer Tank 50L", 320, 560),
        ("Inverter Board", 420, 780), ("Refrigerant Line Kit", 130, 260), ("Wall Bracket Set", 60, 120),
        ("Immersion Heater 3kW", 70, 140), ("Weather Compensation Sensor", 40, 90),
    ],
    "smart_meter": [
        ("SMET2 Electric Meter", 48, 78), ("SMET2 Gas Meter", 52, 84), ("Comms Hub", 30, 58),
        ("In-Home Display", 22, 44), ("Meter Adaptor Kit", 9, 21), ("Isolation Switch", 12, 26),
    ],
    "ev_charger": [
        ("7kW Charge Point", 380, 620), ("22kW Charge Point", 520, 880), ("Tethered Cable 5m", 90, 170),
        ("CT Clamp Kit", 30, 62), ("Backplate Kit", 25, 55), ("Type 2 Socket", 60, 115),
    ],
}
_CAT_BRANDS = {
    "boiler": ["Vaillant", "Navien", "Ideal", "Worcester", "Baxi", "Potterton", "Glow-worm", "Viessmann"],
    "heat_pump": ["Mitsubishi", "Daikin", "Samsung", "Vaillant", "Grant"],
    "smart_meter": ["Landis+Gyr", "Itron", "Aclara", "Secure"],
    "ev_charger": ["Alfen", "Sync EV", "Zappi", "Wallbox", "Rolec"],
}
_CAT_SUPPLIERS = {
    "boiler": ["VAI_UK", "NAV_UK", "WOL_UK"],
    "heat_pump": ["MIT_HV", "DAI_EU", "SAM_HA"],
    "smart_meter": ["LAND_UK", "ITE_UK"],
    "ev_charger": ["ALF_NL", "SYN_UK"],
}


def _extend_sku_catalogue() -> None:
    """Grow the catalogue to SKU_CATALOGUE_SIZE with a deterministic long tail.
    Seeded so the snapshot, the planning policy and every derived number stay
    stable across restarts."""
    rng = random.Random(20260718)
    cats = ["boiler", "heat_pump", "smart_meter", "ev_charger"]
    weights = [0.60, 0.15, 0.14, 0.11]
    counters = {c: 100 for c in cats}
    while len(SKU_CONFIG) < SKU_CATALOGUE_SIZE:
        cat = rng.choices(cats, weights)[0]
        counters[cat] += 1
        code = f"SKU-{_CAT_PREFIX[cat]}-{counters[cat]}"
        if code in SKU_CONFIG:
            continue
        part, lo_cost, hi_cost = rng.choice(_PART_FAMILIES[cat])
        brand = rng.choice(_CAT_BRANDS[cat])
        unit_cost = round(rng.uniform(lo_cost, hi_cost), 2)
        # Long-tail parts move slower than the hero SKUs; heat pumps are lumpier.
        if cat == "boiler":
            daily, lead, review, cv = rng.randint(1, 30), rng.randint(2, 9), rng.choice([7, 14]), round(rng.uniform(0.22, 0.72), 2)
        elif cat == "heat_pump":
            daily, lead, review, cv = rng.randint(1, 7), rng.randint(70, 120), 14, round(rng.uniform(0.45, 0.85), 2)
        elif cat == "smart_meter":
            daily, lead, review, cv = rng.randint(4, 40), rng.randint(5, 12), 7, round(rng.uniform(0.10, 0.30), 2)
        else:
            daily, lead, review, cv = rng.randint(1, 14), rng.randint(12, 28), 14, round(rng.uniform(0.30, 0.65), 2)
        SKU_CONFIG[code] = {
            "daily_consumption": daily, "safety_stock": daily * lead,
            "lead_time_days": lead, "review_period_days": review,
            "unit_cost_gbp": unit_cost, "demand_cv": cv,
        }
        SKU_DESCRIPTION[code] = f"{part} - {brand}"
        SKU_CATEGORY[code] = cat
        SKU_PRIMARY_SUPPLIER[code] = rng.choice(_CAT_SUPPLIERS[cat])


_extend_sku_catalogue()


# ── Cost-to-serve parameters (£-optimisation lens) ───────────────────────────
# Carrying cost blends capital, storage, insurance and obsolescence; the stockout
# penalty blends lost margin, emergency-freight and goodwill; the expedite premium
# is the freight uplift for pulling an order in. These turn RAG-on-cover into a
# £ trade-off the planner can rank on.
HOLDING_COST_RATE_PA = 0.22     # annual holding cost as a fraction of unit cost
STOCKOUT_PENALTY_RATE = 0.35    # penalty per unit short, as a fraction of unit cost
EXPEDITE_PREMIUM_RATE = 0.18    # freight premium on an expedited order value


def _z_for_service(service_pct: float) -> float:
    """Inverse standard-normal CDF (Acklam's rational approximation) — turns a
    cycle-service-level target into the safety factor z. This is what makes the
    buffer statistical rather than hand-set."""
    p = min(0.99995, max(0.5, service_pct / 100.0))
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p <= phigh:
        q = p - 0.5
        r = q * q
        return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)
    q = math.sqrt(-2 * math.log(1 - p))
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)


def _compute_planning_policy() -> dict:
    """Deterministic per-SKU planning policy derived from the SKU master data.

    ABC comes from annual consumption value (80/95% cumulative cuts); XYZ from the
    demand coefficient of variation; the service-level target is differentiated by
    both. Safety stock is then sized with a King's-formula variant that combines
    demand variability AND supplier lead-time variability over the protection
    interval — so the buffer answers to the service target, volatility and supplier
    reliability, not a hand-typed constant."""
    otif = {s["supplier_code"]: s["otif_base"] for s in SUPPLIER_DATA}
    annual_value = {k: v["daily_consumption"] * 365 * v["unit_cost_gbp"] for k, v in SKU_CONFIG.items()}
    total_av = sum(annual_value.values()) or 1
    ranked = sorted(SKU_CONFIG, key=lambda k: annual_value[k], reverse=True)
    cum, abc_by = 0.0, {}
    for k in ranked:
        cum += annual_value[k] / total_av
        abc_by[k] = "A" if cum <= 0.80 else ("B" if cum <= 0.95 else "C")

    policy = {}
    for sku, cfg in SKU_CONFIG.items():
        cv = cfg["demand_cv"]
        daily = cfg["daily_consumption"]
        lead = cfg["lead_time_days"]
        review = cfg["review_period_days"]
        abc = abc_by[sku]
        xyz = "X" if cv <= 0.25 else ("Y" if cv <= 0.50 else "Z")
        base_sl = {"A": 98.5, "B": 97.0, "C": 95.0}[abc]
        service_pct = round(base_sl + (0.5 if xyz == "X" else 0.0 if xyz == "Y" else -1.5), 1)
        z = _z_for_service(service_pct)
        # Supplier reliability → lead-time coefficient of variation: a 90% OTIF
        # supplier carries ~9% lead-time CV, a 65% supplier ~31%.
        supplier_otif = otif.get(SKU_PRIMARY_SUPPLIER.get(sku, "WOL_UK"), 90)
        lead_cv = round(max(0.05, (100 - supplier_otif) / 100 * 0.9), 3)
        sigma_daily = cv * daily
        sigma_lead = lead * lead_cv
        protection = lead + review
        # SS = z · √( protection·σ_d²  +  d̄²·σ_L² )
        ss = z * math.sqrt(protection * sigma_daily ** 2 + (daily ** 2) * sigma_lead ** 2)
        policy[sku] = {
            "abc_class": abc,
            "xyz_class": xyz,
            "segment": f"{abc}{xyz}",
            "service_level_target_pct": service_pct,
            "z": round(z, 3),
            "demand_cv": cv,
            "lead_time_cv": lead_cv,
            "sigma_daily": round(sigma_daily, 2),
            "sigma_lead_days": round(sigma_lead, 2),
            "protection_days": protection,
            "safety_stock": int(round(ss)),
            "safety_stock_static": cfg["safety_stock"],   # kept for the before/after story
            "annual_value_gbp": round(annual_value[sku]),
            "unit_cost_gbp": cfg["unit_cost_gbp"],
            "primary_supplier": SKU_PRIMARY_SUPPLIER.get(sku, "WOL_UK")}
    return policy


# Computed once at import — deterministic, so scenario recomputes stay consistent.
PLANNING_POLICY = _compute_planning_policy()


def _safety_stock(sku_code: str) -> int:
    """Statistical safety stock for a SKU (falls back to the master constant)."""
    p = PLANNING_POLICY.get(sku_code)
    if p:
        return p["safety_stock"]
    return SKU_CONFIG.get(sku_code, {}).get("safety_stock", 100)


# ── Signal → SKU demand elasticity ───────────────────────────────────────────
# The demand model uses exactly four inputs: a base rate, category seasonality,
# weather and IoT. Each signal is scoped by CATEGORY (not a hand-listed SKU set)
# so it applies uniformly across a catalogue of any size — a cold snap lifts
# boiler parts, not EV chargers. `kind` selects how the raw signal is scored:
#   ratio → deviation of the signal from `ref`, scaled by `elasticity`
#   flag  → a fixed `bump` when the boolean signal is true
DEMAND_DRIVERS = {
    "heating_degree_days": {
        "label": "Cold weather (heating degree days)", "group": "weather",
        "path": "weather.heating_degree_days_7d", "kind": "ratio",
        # The reference must be the SEASONAL norm, not a flat annual constant. The
        # baseline already knows July is mild via the seasonality curve; scoring
        # against a fixed 60 subtracted that mildness a second time — summer was
        # double-penalised and winter double-boosted. Sensing must only fire when
        # the weather deviates from what is normal FOR THE TIME OF YEAR.
        "ref_monthly": (78.0, 78.0, 70.0, 45.0, 38.0, 34.0, 33.0, 34.0, 55.0, 68.0, 76.0, 80.0),
        "ref": 60.0,   # fallback only
        "elasticity": 0.55, "categories": ("boiler",)},
    "frozen_condensate": {
        "label": "Frozen condensate lockouts", "group": "weather",
        "path": "weather.frozen_condensate_risk", "kind": "flag", "bump": 0.16,
        "categories": ("boiler",)},
    "hive_faults": {
        "label": "Hive IoT predicted faults", "group": "iot",
        "path": "hive_faults.high_probability_signals_24h", "kind": "ratio", "ref": 2800.0,
        "elasticity": 0.22, "categories": ("boiler", "smart_meter")},
}

# Bill-of-materials: an install/service job explodes into component demand at these
# attach rates, turning the CPQ / install pipeline into dependent part demand.
INSTALL_BOM = {
    "heat_pump_install": {
        "label": "Heat-pump installs", "pipeline_path": "cpq_pipeline.heat_pump_boms_active",
        "weekly_rate_path": None, "horizon_share": 0.28,
        "components": [
            {"sku_code": "SKU-HP-001", "attach": 0.55}, {"sku_code": "SKU-HP-002", "attach": 0.45},
            {"sku_code": "SKU-BLR-001", "attach": 0.35}, {"sku_code": "SKU-BLR-005", "attach": 0.80},
        ]},
    "smart_meter_install": {
        "label": "Smart-meter installs", "pipeline_path": "cpq_pipeline.smart_meter_boms_active",
        "weekly_rate_path": "mhhs_schedule.install_rate_per_week", "horizon_share": 1.0,
        "components": [{"sku_code": "SKU-SM-001", "attach": 1.0}]},
    "ev_charger_install": {
        "label": "EV-charger installs", "pipeline_path": "cpq_pipeline.ev_charger_boms_active",
        "weekly_rate_path": None, "horizon_share": 0.5,
        "components": [{"sku_code": "SKU-EV-001", "attach": 1.0}, {"sku_code": "SKU-BLR-005", "attach": 0.15}]},
}

# Per-category seasonal demand shape by calendar month (1.0 = annual average).
# Boilers spike in the winter breakdown season; heat-pump & EV installs track the
# spring/summer grant-and-build window; smart-meter rollout is roughly flat.
_SEASONALITY = {
    "boiler":      [1.34, 1.30, 1.18, 0.92, 0.74, 0.66, 0.64, 0.70, 0.96, 1.18, 1.30, 1.36],
    "heat_pump":   [0.78, 0.82, 0.94, 1.08, 1.20, 1.26, 1.24, 1.18, 1.06, 0.96, 0.84, 0.78],
    "smart_meter": [0.98, 1.00, 1.02, 1.03, 1.02, 1.01, 1.00, 1.00, 1.00, 0.99, 0.98, 0.97],
    "ev_charger":  [0.82, 0.86, 0.96, 1.06, 1.16, 1.22, 1.20, 1.14, 1.06, 0.98, 0.88, 0.82],
}


def _signal_value(signals: dict, path: str):
    node = signals or {}
    for part in path.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    return node


def _driver_scores(signals: dict) -> dict:
    """Score every demand driver from the live signals → {driver_key: intensity}.
    A positive intensity means the driver is pushing demand up right now."""
    scores = {}
    for key, drv in DEMAND_DRIVERS.items():
        val = _signal_value(signals, drv["path"])
        if drv["kind"] == "flag":
            scores[key] = drv["bump"] if val else 0.0
        else:
            # Seasonal reference where defined, so the driver measures deviation
            # from the norm for THIS month rather than from an annual constant.
            monthly = drv.get("ref_monthly")
            ref = monthly[datetime.now(timezone.utc).month - 1] if monthly else drv.get("ref")
            if not val or not ref:
                scores[key] = 0.0
            else:
                dev = (float(val) / ref) - 1.0
                scores[key] = round(max(-0.5, min(1.2, dev)) * drv["elasticity"], 4)
    return scores


# ── Demand-sensing horizon decay ─────────────────────────────────────────────
# Demand sensing is a SHORT-horizon layer sitting on top of the baseline
# statistical forecast (o9 / Kinaxis / RELEX / ToolsGroup all model it this way).
# Its influence has to fade with horizon, because the signals it rides on do:
# a Met Office forecast is credible ~7 days, useful to ~14, and noise beyond ~21.
# Applying a cold-snap uplift flat across 90 days would be a modelling error.
SENSING_FULL_DAYS = 7        # full weight inside the reliable forecast window
SENSING_ZERO_DAYS = 21       # decayed to nothing by here


def _sensing_weight(day: int) -> float:
    """Weight of the sensing layer on a given forward day (1.0 → 0.0)."""
    if day <= SENSING_FULL_DAYS:
        return 1.0
    if day >= SENSING_ZERO_DAYS:
        return 0.0
    return round((SENSING_ZERO_DAYS - day) / (SENSING_ZERO_DAYS - SENSING_FULL_DAYS), 4)


def _horizon_sensing_weight(horizon: int) -> float:
    """Average sensing weight across a horizon — how much of the signal survives."""
    if horizon <= 0:
        return 0.0
    return round(sum(_sensing_weight(d) for d in range(1, horizon + 1)) / horizon, 4)


def _sku_sensitivity(sku_code: str, driver_key: str) -> float:
    """Per-SKU sensitivity to a given driver (≈0.35–1.65, deterministic).

    Without this every SKU in a category responds identically to a signal, which
    makes any 'biggest movers' or exception ranking meaningless — the list is just
    'every boiler SKU' in arbitrary order. In reality sensitivity varies a lot
    within a category: a diverter valve is highly weather-elastic, a control PCB
    barely at all.

    Uses FNV-1a rather than Python's hash(), which is salted per process and would
    silently change every restart — desyncing from the persisted snapshot."""
    h = 0x811C9DC5
    for ch in f"{sku_code}|{driver_key}":
        h = ((h ^ ord(ch)) * 0x01000193) & 0xFFFFFFFF
    return round(0.35 + ((h & 0xFFFF) / 0xFFFF) * 1.30, 3)


def _sku_demand_multiplier(sku_code: str, signals: dict, scores: dict | None = None) -> tuple[float, list]:
    """Composite demand multiplier for a SKU from the signals that actually move
    its category, plus the per-driver breakdown for explainability. Clamped to a
    sane band so days-of-cover stays realistic.

    `scores` can be passed in when looping a large catalogue so the signals are
    scored once rather than once per SKU."""
    if scores is None:
        scores = _driver_scores(signals)
    category = SKU_CATEGORY.get(sku_code, "boiler")
    contributions = []
    total = 0.0
    for key, drv in DEMAND_DRIVERS.items():
        if category not in drv["categories"]:
            continue
        # Category score scaled by this SKU's own sensitivity to the driver
        contrib = scores.get(key, 0.0) * _sku_sensitivity(sku_code, key)
        if abs(contrib) < 0.0005:
            continue
        contributions.append({"driver": key, "label": drv["label"], "group": drv["group"],
                              "delta": round(contrib, 4),
                              "sensitivity": _sku_sensitivity(sku_code, key)})
        total += contrib
    mult = max(0.6, min(1.9, 1.0 + total))
    return round(mult, 4), contributions

# Per-scenario ranges used by tick() to vary values realistically within each scenario's health band.
# Format: {wh_code: (pct_lo, pct_hi)}, demand_uplift: (lo, hi)
# Warehouse throughput ranges are used directly (no hourly factor applied to pct —
# throughput_vs_baseline_pct is daytime-relative; items_per_hour is also kept consistent).
SCENARIO_TICK_RANGES: dict[str, dict] = {
    "normal": {
        # Usual day: mostly healthy, LEI/MAN can dip briefly below 85 (amber)
        "warehouses": {
            "LEI_COE": (78, 100), "COV_HUB": (84, 102), "MAN_HUB": (76, 100), "CAR_HUB": (84, 102)},
        "demand_uplift": (1.12, 1.28)},
    "p1_3pl_closure": {
        "warehouses": {
            "LEI_COE": (10, 18), "COV_HUB": (110, 120), "MAN_HUB": (85, 97), "CAR_HUB": (85, 97)},
        "demand_uplift": (1.12, 1.28)},
    "p2_stockout": {
        "warehouses": {
            "LEI_COE": (85, 97), "COV_HUB": (85, 97), "MAN_HUB": (85, 97), "CAR_HUB": (85, 97)},
        "demand_uplift": (1.12, 1.28)},
    "beast_from_east": {
        "warehouses": {
            "LEI_COE": (85, 97), "COV_HUB": (85, 97), "MAN_HUB": (85, 97), "CAR_HUB": (85, 97)},
        "demand_uplift": (1.38, 1.46)},
    "supplier_insolvency": {
        "warehouses": {
            "LEI_COE": (85, 97), "COV_HUB": (85, 97), "MAN_HUB": (85, 97), "CAR_HUB": (85, 97)},
        "demand_uplift": (1.12, 1.28)},
    "heat_pump_surge": {
        "warehouses": {
            "LEI_COE": (85, 97), "COV_HUB": (85, 97), "MAN_HUB": (85, 97), "CAR_HUB": (85, 97)},
        "demand_uplift": (1.15, 1.28)},
    "port_congestion": {
        "warehouses": {
            "LEI_COE": (82, 95), "COV_HUB": (84, 100), "MAN_HUB": (80, 95), "CAR_HUB": (84, 100)},
        "demand_uplift": (1.12, 1.28)},
    "cyber_incident": {
        "warehouses": {
            "LEI_COE": (26, 36), "COV_HUB": (100, 115), "MAN_HUB": (85, 97), "CAR_HUB": (85, 97)},
        "demand_uplift": (1.12, 1.28)},
    "fuel_crisis": {
        "warehouses": {
            "LEI_COE": (70, 84), "COV_HUB": (72, 86), "MAN_HUB": (70, 84), "CAR_HUB": (72, 86)},
        "demand_uplift": (1.10, 1.20)},
    "locker_outage": {
        "warehouses": {
            "LEI_COE": (78, 100), "COV_HUB": (84, 102), "MAN_HUB": (76, 100), "CAR_HUB": (84, 102)},
        "demand_uplift": (1.12, 1.28)},
    "courier_shortage": {
        "warehouses": {
            "LEI_COE": (80, 95), "COV_HUB": (84, 100), "MAN_HUB": (70, 82), "CAR_HUB": (84, 100)},
        "demand_uplift": (1.12, 1.28)},
    "supplier_otif_dip": {
        "warehouses": {
            "LEI_COE": (78, 100), "COV_HUB": (84, 102), "MAN_HUB": (76, 100), "CAR_HUB": (84, 102)},
        "demand_uplift": (1.12, 1.28)},
}

ALERT_RULES_SEED = [
    {"rule_code": "RULE_P1_3PL_CLOSURE", "name": "TVS SCS Full Site Closure", "priority": "P1",
     "metric_source": "warehouse_throughput", "condition": {"field": "throughput_vs_baseline_pct", "operator": "<", "value": 40, "duration_minutes": 60},
     "notification_channels": {"in_app": True, "email": True, "sms": True, "slack": True}, "is_active": True},
    {"rule_code": "RULE_P2_CRITICAL_STOCKOUT", "name": "Critical SKU Stockout (Top 50)", "priority": "P2",
     "metric_source": "warehouse_inventory", "condition": {"field": "quantity_available", "operator": "=", "value": 0, "sku_tier": "critical"},
     "notification_channels": {"in_app": True, "email": True, "sms": False, "slack": True}, "is_active": True},
    {"rule_code": "RULE_P3_LOCKER_FAILURE", "name": "Pre-8AM Locker Delivery Gap", "priority": "P3",
     "metric_source": "locker_inventory", "condition": {"field": "pre_8am_delivered", "operator": "=", "value": False, "count_threshold": 5},
     "notification_channels": {"in_app": True, "email": True, "sms": False, "slack": False}, "is_active": True},
    {"rule_code": "RULE_P4_OTIF_DEGRADATION", "name": "Supplier OTIF Degradation", "priority": "P4",
     "metric_source": "supplier_scorecards", "condition": {"field": "otif_score", "operator": "<", "value": 80, "consecutive_weeks": 2},
     "notification_channels": {"in_app": True, "email": False, "sms": False, "slack": False}, "is_active": True},
    {"rule_code": "RULE_P3_SHIPMENT_ETA", "name": "Inbound Shipment ETA Deviation >4h", "priority": "P3",
     "metric_source": "inbound_shipments", "condition": {"field": "delay_hours", "operator": ">", "value": 4},
     "notification_channels": {"in_app": True, "email": True, "sms": False, "slack": False}, "is_active": True},
    {"rule_code": "RULE_P3_VAN_STOCK_LOW", "name": "Engineer Van Stock Below Minimum", "priority": "P3",
     "metric_source": "van_stock", "condition": {"field": "is_below_min", "operator": "=", "value": True},
     "notification_channels": {"in_app": True, "email": False, "sms": False, "slack": False}, "is_active": True},
]


# ═════════════════════════════════════════════════════════════════════════════
# AGENTIC AI LAYER — multi-agent fleet, one capability-named specialist per
# control-tower domain. This is the SYNTHETIC source of truth the agent engine
# reasons over: the roster (its module · sections · real actions) and the
# OPTIMIZED per-action autonomy thresholds that decide — deterministically —
# what each agent may execute on its own versus what it must escalate to a human.
# Agents are named for what they DO, not for the screen they live on.
# ═════════════════════════════════════════════════════════════════════════════

# Per-action policy is no longer written here — it is DERIVED from ACTION_CATALOG
# (app/synthetic/actions.py), which also carries the module, tab, permission,
# reversibility, blast radius and the plain-English reason a human is required.
# `ACTION_THRESHOLDS` is imported at the top of this file and keeps the exact
# shape the agent engine has always consumed:
#   {threshold_key: {label, autonomy, value_ceiling_gbp, severity_ceiling,
#                    confidence_floor, dual_control, module, tab, permission,
#                    approval_trigger, why_human, consults, …}}

# The fleet. Each agent maps to one module, watches specific sections of it, and
# owns a set of real, executable actions gated by the thresholds above.
AGENT_FLEET_SPEC = [
    {"id": "orchestrator", "name": "ATLAS", "role": "Master Agent · Autonomous Tower Logistics Agent System",
     "module": "/", "module_label": "Executive Dashboard", "icon": "Sparkles", "accent": "#8B5CF6",
     "sections": ["Executive KPIs", "AI Insights", "Daily Briefing"],
     "mandate": "The one agent the operator sees and talks to. Behind the scenes it runs a set of "
                "specialist capabilities across every module, de-duplicates their signals and ranks the "
                "queue so the highest value-at-risk decision is always on top — the operator never has "
                "to know which capability produced it.",
     "senses": ["All proposals", "Open exceptions", "Network-wide KPIs"], "actions": []},

    {"id": "replenishment", "name": "Replenishment & Inventory", "role": "Service level & working capital",
     "module": "/demand", "module_label": "Demand & Inventory", "icon": "Package", "accent": "#3B82F6",
     "sections": ["Inventory Health", "Replenishment Orders", "Stock Transfers", "Excess & Disposition"],
     "mandate": "Protects service level and working capital — orders and transfers stock before an amber "
                "SKU turns red, expedites what is already late, and frees capital trapped in excess.",
     "senses": ["Days of supply", "Reorder points", "Open POs", "Excess stock"],
     "actions": [
         {"type": "raise_po", "threshold_key": "raise_po_standard", "label": "Raise PO"},
         {"type": "raise_po", "threshold_key": "raise_po_emergency", "label": "Emergency PO"},
         {"type": "raise_transfer", "threshold_key": "raise_transfer", "label": "Stock transfer"},
         {"type": "expedite_po", "threshold_key": "expedite_po", "label": "Expedite PO"},
         {"type": "create_disposition", "threshold_key": "create_disposition", "label": "Disposition"}]},

    {"id": "exception", "name": "Exception Response", "role": "SLA & incident playbooks",
     "module": "/exceptions", "module_label": "Exceptions", "icon": "AlertTriangle", "accent": "#EF4444",
     "sections": ["Operational Alerts", "AI Response Playbooks", "Resolution Tracking"],
     "mandate": "Watches every open exception against its SLA — activates the researched response "
                "playbook, acknowledges ownership and closes resolved incidents.",
     "senses": ["Open P1/P2/P3 exceptions", "SLA elapsed", "Response playbooks"],
     "actions": [
         {"type": "activate_plan", "threshold_key": "activate_plan", "label": "Activate plan"},
         {"type": "acknowledge", "threshold_key": "acknowledge", "label": "Acknowledge"},
         {"type": "resolve_exception", "threshold_key": "resolve_exception", "label": "Resolve"}]},

    {"id": "supplier", "name": "Supplier Risk", "role": "OTIF, financial & ethical risk",
     "module": "/risk", "module_label": "Supplier & Labour Risk", "icon": "ShieldCheck", "accent": "#0EA5E9",
     "sections": ["Supplier Scorecards", "Labour Risk", "Warehouse Health"],
     "mandate": "Turns lagging supplier signals into leading ones — OTIF drift and financial-health "
                "flags become a review or a watch-list before they become a delivery failure.",
     "senses": ["Supplier OTIF", "Financial-health flag", "Sedex risk", "Composite risk"],
     "actions": [
         {"type": "supplier_review", "threshold_key": "supplier_review", "label": "Open review"},
         {"type": "otif_watchlist", "threshold_key": "otif_watchlist", "label": "Watch-list"}]},

    {"id": "transport", "name": "Fleet & Compliance", "role": "Vehicles, walkarounds & CAZ",
     "module": "/transport", "module_label": "Transport Control", "icon": "Truck", "accent": "#F59E0B",
     "sections": ["Fleet Status", "Daily Walkarounds", "Clean Air Zones", "Route Optimisation"],
     "mandate": "Keeps engineers moving and legal — clears vehicle defects, chases missing DVSA "
                "walkarounds and re-sequences replenishment runs before a route is lost.",
     "senses": ["Vehicles off road", "Walkaround compliance", "CAZ compliance", "Van stock low"],
     "actions": [
         {"type": "resolve_defect", "threshold_key": "resolve_defect", "label": "Clear defect"},
         {"type": "agent_task", "threshold_key": "walkaround_reminder", "label": "Walkaround reminder"},
         {"type": "agent_task", "threshold_key": "resequence_run", "label": "Re-sequence run"}]},

    {"id": "demand_sensing", "name": "Demand Sensing", "role": "Weather & IoT-driven demand",
     "module": "/iot", "module_label": "IoT & Smart Tech", "icon": "Cpu", "accent": "#10B981",
     "sections": ["Boiler Fault Pipeline", "Predictive Replacements", "Smart Meter Rollout"],
     "mandate": "Reads weather, Hive IoT telemetry and grant signals to pre-position parts and queue "
                "proactive outreach ahead of the demand they predict.",
     "senses": ["Heating degree days", "Hive fault signals", "Condensate lockouts", "Grant pipeline"],
     "actions": [
         {"type": "agent_task", "threshold_key": "pre_position", "label": "Pre-position stock"},
         {"type": "agent_task", "threshold_key": "proactive_outreach", "label": "Queue outreach"}]},

    {"id": "visibility", "name": "Network Visibility", "role": "Lockers, inbound & throughput",
     "module": "/visibility", "module_label": "Live Visibility Hub", "icon": "Radar", "accent": "#6366F1",
     "sections": ["Live Map", "Locker Network", "Inbound Shipments", "Warehouse Throughput"],
     "mandate": "Watches the physical network in real time — fails over dead lockers, reroutes delayed "
                "inbound stock and flags throughput collapse before pre-8AM delivery fails.",
     "senses": ["Locker health", "Inbound ETA deviation", "Warehouse throughput", "Engineer positions"],
     "actions": [
         {"type": "agent_task", "threshold_key": "locker_failover", "label": "Locker failover"},
         {"type": "agent_task", "threshold_key": "reroute_inbound", "label": "Reroute inbound"}]},

    {"id": "sustainability", "name": "Sustainability & Reverse Logistics", "role": "Reverse logistics & Scope 3",
     "module": "/sustainability", "module_label": "Sustainability", "icon": "Leaf", "accent": "#22C55E",
     "sections": ["Reverse Logistics", "WEEE Compliance", "Scope 3 Emissions"],
     "mandate": "Clears the reverse-logistics backlog on time and compliantly — schedules collection "
                "sweeps and consolidates return routes to cut Scope 3 and protect WEEE compliance.",
     "senses": ["Reverse-logistics backlog", "WEEE compliance", "Scope 3 emissions"],
     "actions": [
         {"type": "agent_task", "threshold_key": "collection_sweep", "label": "Collection sweep"}]},
]


FIRST_NAMES = ["James","Sarah","Emma","Tom","Maria","David","Raj","Emma","Oliver","Priya",
               "Mohammed","Charlotte","Liam","Sophie","Aisha","Daniel","Grace","Ahmed","Lucy","Jack"]
LAST_NAMES = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Wilson","Moore","Taylor",
              "Anderson","Thomas","Jackson","White","Harris","Clark","Lewis","Robinson","Walker","Young"]

UK_POSTCODES_BY_REGION = {
    "East Midlands": ["LE1", "LE2", "LE3", "NG1", "NG2", "DE1", "NN1"],
    "West Midlands": ["B1", "B2", "CV1", "WV1", "DY1"],
    "South East": ["SE1", "SW1", "E1", "N1", "W1", "OX1", "RG1", "GU1"],
    "South West": ["BS1", "BA1", "EX1", "PL1", "TQ1"],
    "North West": ["M1", "M2", "L1", "L2", "PR1", "BL1"],
    "North East": ["NE1", "NE2", "SR1", "DH1", "TS1"],
    "Yorkshire": ["LS1", "LS2", "S1", "S2", "HU1", "BD1"],
    "East of England": ["CB1", "IP1", "PE1", "CM1", "CO1"],
    "London": ["EC1", "EC2", "WC1", "WC2", "E14", "SE10"],
    "Wales": ["CF1", "CF2", "SA1", "LL11"],
    "Scotland": ["G1", "G2", "EH1", "EH2", "AB1"],
    "Northern Ireland": ["BT1", "BT2", "BT9"],
}


def rnd(low: float, high: float, decimals: int = 1) -> float:
    return round(random.uniform(low, high), decimals)


def rand_postcode(region: str | None = None) -> str:
    if region and region in UK_POSTCODES_BY_REGION:
        pc_prefix = random.choice(UK_POSTCODES_BY_REGION[region])
    else:
        all_pcs = [pc for pcs in UK_POSTCODES_BY_REGION.values() for pc in pcs]
        pc_prefix = random.choice(all_pcs)
    return f"{pc_prefix} {random.randint(1, 9)}{random.choice('ABCDEFGHJKLMNPQRSTUVWXYZ')}{random.choice('ABCDEFGHJKLMNPQRSTUVWXYZ')}"


def rand_engineer_code() -> str:
    bu_prefix = random.choice(["BG", "DN", "PH", "HV"])
    return f"ENG-{bu_prefix}-{random.randint(10000, 99999)}"


def rand_name() -> str:
    return f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"


class SyntheticState(ResolutionMixin):
    def __init__(self):
        self._snapshot: dict[str, Any] = {}
        self._exception_counter = 0
        self._transfer_counter = 0
        self._po_counter = 0
        self._shipment_counter = 0
        self._initialized = False
        # Guards the rebuild window only (see initialize()). Deliberately NOT a
        # lock over `_snapshot` reads/writes: those are kept safe by every mutator
        # running on the single event-loop thread, which is why `tick` is a
        # coroutine. RLock so a nested rebuild path cannot deadlock itself.
        self._init_lock = threading.RLock()
        self._active_scenario: str | None = None  # set when a scenario is applied; cleared on reset
        # Per-scenario KPI-family degradation overrides applied when a user activates
        # that scenario's AI response plan — merged into _sync_derived_state()'s `eff`
        # so the partial recovery persists across ticks instead of being recomputed
        # back to full-disruption values. Keyed by scenario_id, cleared on any reset.
        self._plan_effect_overrides: dict[str, dict] = {}
        # ── The master switch, server-side ───────────────────────────────────
        # Every state in this engine has TWO variations, and this decides which
        # one the network is currently in:
        #   OFF → the raw scenario. Disruption sits where it landed and waits for
        #         a human. This is the original mechanism, unchanged.
        #   ON  → ATLAS has already worked the incident. Roughly four in five of
        #         the actions the disruption demanded are executed autonomously
        #         inside their guardrails, the network is pulled back to a healthy
        #         state, and only the high-stakes remainder is left in the
        #         approval queue for a human.
        # Defaults ON to match the UI's default; the toggle re-applies the active
        # scenario through the other variation so the switch is a live A/B.
        self._ai_mode: bool = True
        # Identifies the CURRENT world. Bumped whenever the snapshot is rebuilt
        # from scratch — a scenario applied, a reset, a regenerate. Consumers that
        # cache anything keyed to the state of the world (above all the agent
        # engine's decision ledger) compare against this and drop what they hold
        # when it changes: a decision taken about stock that no longer exists must
        # not go on suppressing the recommendation the new world raises.
        self._world_token: str = uuid.uuid4().hex[:12]
        # ── Update cadence ───────────────────────────────────────────────────
        # `tick()` fires on a fast heartbeat, but each parameter family only
        # moves when its OWN interval has elapsed (app/synthetic/cadence.py).
        # `_feed_last` holds the wall-clock epoch each family last ran at;
        # `_holds` pins individual entities against redraw for a window after
        # someone acts on them, so an action's impact is legible before the
        # simulation moves the number again.
        self._feed_last: dict[str, float] = {}
        self._holds: dict[str, float] = {}
        self._tick_seq: int = 0

    # ─────────────────────────────────────────────
    # UPDATE CADENCE
    # ─────────────────────────────────────────────

    def _feed_due(self, feed: str) -> bool:
        """True when this family's interval has elapsed. Records the run."""
        now = time.time()
        last = self._feed_last.get(feed)
        if last is not None and now - last < CAD.feed_seconds(feed):
            return False
        self._feed_last[feed] = now
        return True

    def hold_entity(self, feed: str, entity_key: str) -> None:
        """Pin one entity against random redraw for this feed's hold window."""
        self._holds[entity_key] = time.time() + CAD.hold_seconds(feed)

    def is_held(self, kind: str, ident: str) -> bool:
        expiry = self._holds.get(f"{kind}:{ident}")
        if expiry is None:
            return False
        if expiry <= time.time():
            self._holds.pop(f"{kind}:{ident}", None)
            return False
        return True

    def state_engine_status(self) -> dict:
        """The cadence table plus what each family is actually doing right now —
        rendered by the UI so an operator can see why a number moved (or did
        not) and how long their own action is protected for."""
        self.get_snapshot()   # cold worker: make sure the engine is actually running
        now = time.time()
        feeds = []
        for row in CAD.summary():
            last = self._feed_last.get(row["feed"])
            feeds.append({
                **row,
                "last_run_s_ago": round(now - last) if last else None,
                "next_run_in_s": max(0, round(row["seconds"] - (now - last))) if last else 0,
                "actionable": row["feed"] in CAD.ACTIONABLE_FEEDS,
            })
        holds = [
            {"entity": k, "kind": k.split(":", 1)[0], "expires_in_s": max(0, round(v - now))}
            for k, v in sorted(self._holds.items(), key=lambda kv: kv[1])
            if v > now]
        return {
            "tick_interval_s": CAD.TICK_INTERVAL_S,
            "ticks": self._tick_seq,
            "feeds": feeds,
            "holds": holds,
            "holds_active": len(holds),
            "explainer": (
                "Each parameter family updates at the rate its source system publishes at, not on one "
                "blanket heartbeat. When you resolve something, the entity you touched is held against "
                "random redraw so the impact of your decision stays visible."),
        }

    # ─────────────────────────────────────────────
    # PERSISTENCE HELPERS
    # ─────────────────────────────────────────────

    def _save_snapshot(self) -> None:
        """Serialise the current baseline snapshot to disk."""
        try:
            _DATA_DIR.mkdir(parents=True, exist_ok=True)
            payload = {
                "_meta": {
                    "exception_counter": self._exception_counter,
                    "transfer_counter":  self._transfer_counter,
                    "po_counter":        self._po_counter,
                    "shipment_counter":  self._shipment_counter,
                    "saved_at":          datetime.now(timezone.utc).isoformat()},
                "snapshot": self._snapshot}
            tmp = SNAPSHOT_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, default=str), encoding="utf-8")
            tmp.replace(SNAPSHOT_PATH)  # atomic replace
            _log.info("Synthetic snapshot saved → %s", SNAPSHOT_PATH)
        except Exception as exc:
            _log.warning("Could not save synthetic snapshot: %s", exc)

    def _load_snapshot(self) -> bool:
        """Load snapshot from disk.  Returns True on success, False if file absent/corrupt."""
        if not SNAPSHOT_PATH.exists():
            return False
        try:
            payload = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
            meta = payload.get("_meta", {})
            self._exception_counter = meta.get("exception_counter", 0)
            self._transfer_counter  = meta.get("transfer_counter",  0)
            self._po_counter        = meta.get("po_counter",        0)
            self._shipment_counter  = meta.get("shipment_counter",  0)
            self._snapshot          = payload["snapshot"]
            _log.info("Synthetic snapshot loaded from %s (saved %s)",
                      SNAPSHOT_PATH, meta.get("saved_at", "unknown"))
            return True
        except Exception as exc:
            _log.warning("Snapshot file corrupt or unreadable (%s) – will regenerate.", exc)
            return False

    # Keys newer builds add to the snapshot — a persisted file missing any of
    # them predates the current schema and must be regenerated.
    _REQUIRED_SNAPSHOT_KEYS = ("fleet_vehicles", "engineer_routes", "traffic_severity", "transport_kpis",
                               "transfer_orders", "carrier_movements", "van_stock_alerts", "locker_misses")
    # Bump when baseline generation changes shape/behaviour so persisted
    # snapshots from older builds are regenerated rather than loaded stale.
    # 15: routes carry real optimiser output (skills, parts, traffic, SLA, CAZ,
    #     drivers' hours) instead of a random savings percentage.
    _BASELINE_VERSION = 15

    def initialize(self):
        """Load existing snapshot from disk, or generate + save a new one.

        Serialised. `apply_scenario("normal")` clears `_initialized` and then
        rebuilds; anything reaching `get_snapshot()` during that window sees the
        false flag and would start its *own* rebuild, so two paths could load and
        regenerate the same ~5 MB world at once and a request could be served a
        half-built one. Now that the tick runs on the event loop this is hard to
        provoke from request traffic alone, but the lock costs nothing and keeps
        the invariant true if any caller is ever moved to a thread.
        """
        with self._init_lock:
            self._initialize_locked()

    def _initialize_locked(self):
        if self._initialized:
            return
        if self._load_snapshot():
            if (all(k in self._snapshot for k in self._REQUIRED_SNAPSHOT_KEYS)
                    and self._snapshot.get("baseline_version") == self._BASELINE_VERSION):
                # Same world as the process that saved it — keep its identity so a
                # restart alone does not invalidate decisions taken against it.
                self._world_token = self._snapshot.get("world_token") or self._world_token
                self._snapshot["world_token"] = self._world_token
                self._initialized = True
                self._sync_derived_state()  # derived analytics reflect current code, not the saved file
                return
            _log.info("Persisted snapshot is missing newer keys or outdated – regenerating baseline.")
        else:
            # File missing or corrupt – generate fresh baseline
            _log.info("No snapshot file found at %s – generating fresh baseline.", SNAPSHOT_PATH)
        random.seed(42)
        self._build_snapshot()
        self._sync_derived_state()  # analytics families derived from the same core state
        self._save_snapshot()
        self._initialized = True

    def force_regenerate(self) -> dict:
        """Discard in-memory state, rebuild from scratch, persist to disk, and re-initialise."""
        _log.info("force_regenerate() called – rebuilding synthetic snapshot.")
        with self._init_lock:  # same window as initialize(): never rebuild twice at once
            self._initialized = False
            self._active_scenario = None
            self._exception_counter = 0
            self._transfer_counter = 0
            self._po_counter = 0
            self._shipment_counter = 0
            self._plan_effect_overrides = {}
            random.seed(os.urandom(4).__hash__() & 0xFFFFFFFF)  # fresh random seed each time
            self._build_snapshot()
            self._new_world()
            self._save_snapshot()
            self._initialized = True
        return {"regenerated": True, "snapshot_path": str(SNAPSHOT_PATH)}

    def _build_snapshot(self):
        now = datetime.now(timezone.utc)

        warehouses = self._gen_warehouses(now)
        engineers = self._gen_engineers()
        lockers = self._gen_lockers()
        suppliers = self._gen_suppliers()
        exceptions = self._gen_exceptions(now)
        demand_signals = self._gen_demand_signals()
        inventory = self._gen_inventory(demand_signals)
        # Order matters: the PO book is the source document for inbound freight,
        # so it has to exist before shipments can be derived from it. POs in turn
        # need the catalogue, because every PO names a real SKU.
        purchase_orders = self._gen_purchase_orders(now, inventory)
        shipments = self._gen_shipments(now, purchase_orders)
        fleet = self._gen_fleet(engineers)
        # Routes are optimised against parts availability, so every engineer must
        # know which forward stock location is theirs before the day is planned.
        self._assign_lockers(engineers, lockers)

        self._snapshot = {
            "last_refresh": now.isoformat(),
            "warehouse_status": warehouses,
            "engineer_locations": engineers,
            "fleet_vehicles": fleet,
            "engineer_routes": self._gen_routes(engineers, lockers, fleet),
            "traffic_severity": "normal",
            "baseline_version": self._BASELINE_VERSION,
            "locker_status": lockers,
            "supplier_scorecards": suppliers,
            "shipments": shipments,
            "exceptions": exceptions,
            "inventory_positions": inventory,
            "purchase_orders": purchase_orders,
            "transfer_orders": self._gen_transfer_orders(now),
            "alert_rules": ALERT_RULES_SEED,
            "kpis": self._gen_kpis(),
            "exceptions_summary": self._gen_exceptions_summary(exceptions),
            "active_engineer_count": len([e for e in engineers if e["job_status"] != "off_duty"]),
            "lockers_healthy_pct": rnd(91, 98),
            "shipments_in_transit": len([s for s in shipments if s["status"] == "in_transit"]),
            "demand_signals": demand_signals,
            "forecasts": {},
            "heat_pump_pipeline": self._gen_heat_pump_pipeline(),
            "smart_meter_dashboard": self._gen_smart_meter_dashboard(),
            "boiler_fault_pipeline": self._gen_boiler_faults(now),
            "predictive_replacements": self._gen_predictive_replacements(),
            "smart_meter_status": self._gen_smart_meter_status(demand_signals),
            "van_telematics": self._gen_van_telematics(engineers, fleet, now),
            "reverse_pipeline": self._gen_reverse_pipeline(),
            "sustainability_dashboard": self._gen_sustainability_dashboard(),
            "hts_batches": self._gen_hts_batches(),
            "scope3_emissions": self._gen_scope3_emissions(),
            "circular_economy_kpis": self._gen_circular_economy_kpis(),
            "executive_kpis": self._gen_executive_kpis(),
            "operational_kpis": self._gen_operational_kpis(),
            "procurement_kpis": self._gen_procurement_kpis(),
            "sustainability_kpis": self._gen_sustainability_kpis(),
            "field_dispatcher_kpis": self._gen_field_dispatcher_kpis(engineers),
            "transport_kpis": self._gen_transport_kpis(),
            "labour_assessments": self._gen_labour_assessments(),
            "agent_layer": self._gen_agent_layer(),
            # ── Operational resolution layer ─────────────────────────────────
            # Third-party carrier legs out of the hubs, and the three alert
            # families an operator works from: van stock, pre-8AM locker misses
            # and arrival risk. The alert lists are derived below so they can
            # never disagree with the state they are derived from.
            "carrier_movements": [],
            "van_stock_alerts": [],
            "locker_misses": [],
            "route_eta_risk": [],
            "van_transfers": [],
            "van_replenishment_orders": [],
            "resolution_log": [],
            "integration_log": []}

        self.gen_carrier_movements()
        self.refresh_van_stock_alerts()
        self.refresh_locker_misses()
        self.refresh_route_eta_risk()

    def _gen_agent_layer(self) -> dict:
        """Multi-agent AI config surfaced as part of the synthetic state so the
        feature demos properly: the capability-named roster (module · sections ·
        real actions) and the optimised per-action autonomy thresholds. The
        agent engine reasons over this; nothing here is random — it is the fixed
        contract for what each agent is and may do."""
        return {
            "fleet_autonomy": "auto",   # autonomous by default, gated per action
            "agents": AGENT_FLEET_SPEC,
            "action_thresholds": ACTION_THRESHOLDS,
            "seed_activity": self._gen_agent_seed_activity(),
        }

    def _gen_agent_seed_activity(self) -> list:
        """A realistic recent-history feed so the console isn't empty on first
        load — routine actions the fleet already auto-executed today, plus a
        human approval and a governance change."""
        now = datetime.now(timezone.utc)
        def ts(mins):
            return (now - timedelta(minutes=mins)).isoformat()
        return [
            {"ts": ts(6),   "agent_id": "transport", "agent_name": "Fleet & Compliance", "module_label": "Transport Control", "kind": "auto",
             "title": "Pushed DVSA walkaround reminder to 7 drivers",
             "detail": "Auto-executed within guardrails · walkaround compliance restored before first job.", "by": "fleet-auto"},
            {"ts": ts(18),  "agent_id": "replenishment", "agent_name": "Replenishment & Inventory", "module_label": "Demand & Inventory", "kind": "auto",
             "title": "Raised standard PO for Diverter Valve (Vaillant)",
             "detail": "Auto-executed within guardrails · £14,200 order, below the £25k auto-approve threshold.", "by": "fleet-auto"},
            {"ts": ts(34),  "agent_id": "demand_sensing", "agent_name": "Demand Sensing", "module_label": "IoT & Smart Tech", "kind": "auto",
             "title": "Queued proactive outreach on 240 high-risk boilers",
             "detail": "Auto-executed within guardrails · Hive fault signals above threshold.", "by": "fleet-auto"},
            {"ts": ts(52),  "agent_id": "supplier", "agent_name": "Supplier Risk", "module_label": "Supplier & Labour Risk", "kind": "approved",
             "title": "Opened contingency review: Mitsubishi HVAC",
             "detail": "Escalated (financial-health flag) — approved by supply.director@abc.com.", "by": "supply.director@abc.com"},
            {"ts": ts(75),  "agent_id": "sustainability", "agent_name": "Sustainability & Reverse Logistics", "module_label": "Sustainability", "kind": "auto",
             "title": "Scheduled collection sweep for 14 decommissioned units",
             "detail": "Auto-executed within guardrails · WEEE compliance protected, empty miles reduced.", "by": "fleet-auto"},
            {"ts": ts(110), "agent_id": "orchestrator", "agent_name": "ATLAS", "module_label": "Executive Dashboard", "kind": "governance",
             "title": "Fleet autonomy confirmed: Autonomous",
             "detail": "Per-action thresholds active — high-stakes actions still escalate to a human.", "by": "system"},
        ]

    def _gen_warehouses(self, now: datetime) -> list:
        result = []
        for wh in WAREHOUSES_DATA:
            baseline = wh["baseline_items_per_hour"]
            pct = rnd(78, 103)  # usual day: mostly healthy, occasional sub-85 amber
            items_hr = round(baseline * pct / 100)
            result.append({
                **wh,
                "items_per_hour": items_hr,
                "throughput_vs_baseline_pct": pct,
                "courier_ot_rate": rnd(93, 98),
                "staff_present": random.randint(28, 52),
                "is_disrupted": pct < 40,
                "labour_risk_score": random.randint(12, 28),
                "throughput_chart": [
                    {"hour": h, "items_per_hour": round(baseline * rnd(0.1, 1.1) * self._hourly_factor(h))}
                    for h in range(24)
                ]},)
        return result

    def _hourly_factor(self, hour: int) -> float:
        if hour < 5:
            return 0.05
        if hour < 7:
            return 0.4
        if hour < 14:
            return 1.0
        if hour < 18:
            return 0.7
        return 0.2

    # Region centres are verified on-land UK points.
    # Jitter is capped at ±0.22 to stay on land for all regions.
    _REGION_CENTRES: dict = {
        "East Midlands":    (52.62, -1.10),   # Nottingham
        "West Midlands":    (52.48, -1.90),   # Birmingham
        "South East":       (51.30, -0.55),   # Surrey/Guildford
        "South West":       (51.10, -2.55),   # Somerset/Taunton
        "North West":       (53.48, -2.24),   # Manchester
        "North East":       (54.78, -1.72),   # Durham
        "Yorkshire":        (53.80, -1.55),   # Leeds
        "East of England":  (52.20,  0.12),   # Cambridge
        "London":           (51.50, -0.10),   # Central London
        "Wales":            (51.85, -3.40),   # Brecon/Merthyr
        "Scotland":         (56.34, -3.72),   # Perth
        "Northern Ireland": (54.60, -6.45),   # Antrim
    }

    def _gen_engineers(self) -> list:
        engineers = []
        for i in range(200):
            bu_weights = [0.55, 0.15, 0.20, 0.10]
            bu = random.choices(ENGINEER_BU, weights=bu_weights)[0]
            region = random.choice(UK_REGIONS)
            postcode_prefix = random.choice(UK_POSTCODES_BY_REGION.get(region, ["LE1"]))
            lat_base, lon_base = self._REGION_CENTRES.get(region, (52.5, -1.5))
            code = f"ENG-{bu[:2].upper()}-{10000 + i}"
            brand = random.choice(BOILER_BRANDS)
            job_status = random.choices(
                ["available", "en_route", "on_site", "break"],
                weights=[0.3, 0.25, 0.35, 0.1]
            )[0]
            van_stock_items = self._gen_van_stock_items()
            has_low = any(v["quantity"] < v["min_quantity"] for v in van_stock_items)

            # Accreditations. These are not decoration — the optimiser treats a
            # missing ticket as a HARD constraint, because gas work without Gas
            # Safe registration is an offence rather than an inefficiency. The
            # two legacy booleans are kept in sync so the Demand and Smart Meter
            # pages carry on reading what they already read.
            smets2 = bu == "ph_jones" and random.random() < 0.4
            heat_pump = random.random() < 0.15
            skills = set()
            if random.random() < 0.92:
                skills.add("gas_safe")
            if smets2 or random.random() < 0.30:
                skills.add("acs_meter")
            if smets2:
                skills.add("smets2")
            if heat_pump:
                skills |= {"mcs_heat_pump", "f_gas"}
            if random.random() < 0.45:
                skills.add("unvented_g3")
            if random.random() < 0.32:
                skills.add("electrical_18th")
            # Nobody is on the road holding no ticket at all. An engineer without
            # Gas Safe is not an unqualified gas engineer — they are a metering
            # and electrical specialist, which is a real role on a UK home-
            # services force (smart meters, EV charge points, controls). Without
            # this, ~8% of engineers came out able to do nothing and their whole
            # round arrived blocked, which is a modelling artefact rather than an
            # operational problem anyone would recognise.
            if "gas_safe" not in skills:
                skills |= {"electrical_18th", "acs_meter"}

            engineers.append({
                "engineer_code": code,
                "name": rand_name(),
                "business_unit": bu,
                "region": region,
                "home_postcode": f"{postcode_prefix} {random.randint(1,9)}AB",
                "latitude": round(lat_base + rnd(-0.22, 0.22, 4), 4),
                "longitude": round(lon_base + rnd(-0.22, 0.22, 4), 4),
                "job_status": job_status,
                "van_stock_low": has_low,
                "van_stock_items": van_stock_items,
                "smet2_certified": smets2,
                "heat_pump_certified": heat_pump,
                "skills": sorted(skills),
                "skill_labels": [SKILL_LABELS[s] for s in sorted(skills)],
                "locker_assignments": [],
                "pending_alerts": []},)
        return engineers

    def _gen_van_stock_items(self) -> list:
        skus = [
            ("SKU-BLR-001", "Diverter Valve - Vaillant ecoTEC", 2, 1),
            ("SKU-BLR-002", "Heat Exchanger - Navien NCB-E", 1, 1),
            ("SKU-BLR-003", "Fan Motor Assembly", 1, 0),
            ("SKU-BLR-004", "PCB Control Board", 1, 1),
            ("SKU-BLR-005", "Pressure Relief Valve", 3, 2),
            ("SKU-BLR-006", "Expansion Vessel", 1, 0),
            ("SKU-BLR-007", "Igniter Assembly", 2, 1),
            # Not a boiler spare, but it lives in the van for the same reason the
            # others do: small, fast-moving, and a job stops without it.
            ("SKU-HIV-001", "Hive Thermostat Kit", 2, 1),
        ]
        # A working van carries the standard list, not a third of it. Gaps are
        # the exception — a line consumed faster than the overnight wave replaced
        # it — which is what makes a locker collection meaningful when it happens.
        items = []
        for sku_code, desc, std, min_qty in random.sample(skus, k=random.randint(6, len(skus))):
            # A well-run van fleet is mostly at or above standard quantities; the
            # exception is a line that has been consumed faster than the
            # overnight wave replaced it. Drawing a flat quantity across the whole
            # range put well over half the fleet below minimum, which is not a
            # working queue — it is a permanent crisis nobody could act on.
            if random.random() < 0.03:
                qty = max(0, min_qty - random.randint(1, max(1, min_qty)))
            else:
                qty = std + random.randint(0, 2)
            items.append({
                "sku_code": sku_code,
                "description": desc,
                "quantity": qty,
                "min_quantity": min_qty,
                "standard_quantity": std,
                "is_below_min": qty < min_qty},)
        return items

    # ── Fleet (Transport Control) ─────────────────────────────────────────
    # One van per engineer, keyed by engineer_code. Positions are NOT stored
    # here — they are joined live from engineer_locations so Transport Control
    # and the Live Visibility Hub always show identical van locations.

    _VAN_MODELS = [
        # (make_model, fuel_type, euro_status, weight)
        ("Ford Transit Custom",     "diesel", "Euro 6", 0.30),
        ("Vauxhall Vivaro",         "diesel", "Euro 6", 0.20),
        ("VW Transporter T6.1",     "diesel", "Euro 6", 0.14),
        ("Mercedes-Benz Vito",      "diesel", "Euro 5", 0.08),
        ("Peugeot Expert",          "diesel", "Euro 5", 0.06),
        ("Ford E-Transit",          "ev",     None,     0.10),
        ("Vauxhall Vivaro-e",       "ev",     None,     0.08),
        ("Toyota Proace Electric",  "ev",     None,     0.04),
    ]

    _DEFECT_TYPES = [
        ("Nearside mirror cracked", "minor"),
        ("Brake lights intermittent", "major"),
        ("Tyre tread below 2mm (front nearside)", "major"),
        ("Windscreen chip in driver sightline", "minor"),
        ("Rear door lock sticking", "minor"),
        ("ABS warning lamp on", "major"),
        ("Wiper blades perished", "minor"),
        ("Exhaust corrosion / blowing", "major"),
    ]

    def _gen_fleet(self, engineers: list) -> list:
        fleet = []
        models = self._VAN_MODELS
        weights = [m[3] for m in models]
        now = datetime.now(timezone.utc)
        for i, eng in enumerate(engineers):
            make_model, fuel, euro, _ = random.choices(models, weights=weights)[0]
            is_ev = fuel == "ev"
            caz_compliant = is_ev or euro == "Euro 6"
            reg = (f"{random.choice('BGKLMOSVWY')}{random.choice('ABDEFGHJKLNP')}"
                   f"{random.choice(['21','22','23','24','73','74'])} "
                   f"{''.join(random.choices('ABCDEFGHJKLMNOPRSTUVWXYZ', k=3))}")
            mot_days = random.randint(5, 360)
            walkaround_done = random.random() < 0.88
            defects = []
            if random.random() < 0.14:
                for d_desc, d_sev in random.sample(self._DEFECT_TYPES, k=random.randint(1, 2)):
                    defects.append({
                        "defect_id": f"DEF-{10000 + i * 3 + len(defects)}",
                        "description": d_desc,
                        "severity": d_sev,
                        "reported_at": (now - timedelta(days=random.randint(0, 6))).isoformat(),
                        "status": "open"},)
            has_major = any(d["severity"] == "major" for d in defects)
            vor = has_major and random.random() < 0.35
            fleet.append({
                "registration": reg,
                "engineer_code": eng["engineer_code"],
                "engineer_name": eng["name"],
                "region": eng["region"],
                "business_unit": eng["business_unit"],
                "make_model": make_model,
                "fuel_type": fuel,
                "euro_status": euro,
                "caz_compliant": caz_compliant,
                "mileage": random.randint(18000, 95000),
                "mot_due_date": (now + timedelta(days=mot_days)).date().isoformat(),
                "mot_due_days": mot_days,
                "service_due_miles": random.randint(200, 8000),
                "walkaround_completed": walkaround_done,
                "walkaround_time": f"{random.randint(6,8):02d}:{random.randint(0,59):02d}" if walkaround_done else None,
                "defects": defects,
                "vor": vor,  # vehicle off road
                "driver_score": random.randint(62, 99),
                "harsh_braking_7d": random.randint(0, 14),
                "speeding_events_7d": random.randint(0, 6),
                "idling_pct": round(rnd(4, 18), 1),
                "hours_driven_today": round(rnd(0.5, 4.8), 1),
                "miles_today": random.randint(12, 140),
                "fuel_cost_month_gbp": random.randint(40, 90) if is_ev else random.randint(180, 420),
                "co2_kg_month": 0 if is_ev else random.randint(280, 520),
                "ev_charge_pct": random.randint(28, 100) if is_ev else None,
                "ev_range_miles": random.randint(60, 190) if is_ev else None},)
        return fleet

    # The daily mix a UK domestic heating round actually carries. Service and
    # repair dominate; a heat pump install is a whole-day job and correspondingly
    # rare. Weights, not a flat choice, so the work profile is believable.
    _JOB_MIX = [
        ("annual_service", 30), ("boiler_repair", 26), ("emergency_callout", 12),
        ("smart_meter_install", 12), ("hive_install", 8), ("heat_pump_survey", 5),
        ("boiler_replacement", 4), ("ev_charger_install", 2), ("heat_pump_install", 1),
    ]

    def _draw_job_type(self, skills: set) -> str:
        """Pick a job type for this engineer. Mostly one they hold the tickets
        for — but not always. Around one round in twelve carries a job the
        engineer cannot legally do, because that is a real dispatch failure and
        the optimiser's job is to surface it for reallocation rather than to
        pretend a perfectly-skilled world."""
        types = [t for t, _ in self._JOB_MIX]
        weights = [w for _, w in self._JOB_MIX]
        if random.random() < 0.92:
            eligible = [(t, w) for t, w in self._JOB_MIX
                        if not routing.skill_gap(JOB_SPECS[t], skills)]
            if eligible:
                types = [t for t, _ in eligible]
                weights = [w for _, w in eligible]
        return random.choices(types, weights=weights)[0]

    @staticmethod
    def _collection_stop(sc: dict) -> dict:
        """An optimiser-planned locker pickup, in the same shape the resolution
        engine uses when a dispatcher inserts one by hand — so the route map,
        the timeline and every stop_kind guard treat the two identically."""
        skus = [ln.get("sku_code") for ln in sc.get("parts_lines", []) if ln.get("sku_code")]
        return {
            "seq": 0,
            "job_code": f"COL-{sc['ref']}",
            "postcode": sc.get("postcode"),
            "latitude": sc.get("latitude"), "longitude": sc.get("longitude"),
            "job_type": "parts_collection",
            "job_label": "Parts collection",
            "stop_kind": "collection",
            "collection_kind": "locker",
            "collection_site": sc.get("ref"),
            "collection_site_name": sc.get("ref"),
            "sku_codes": sorted(set(skus)),
            "service_mins": sc.get("service_mins", 8),
            "priority": "standard",
            "planned_arrival": sc.get("arrive"),
            "optimised_arrival": sc.get("arrive"),
            "sla_deadline": None,
            "serves": sc.get("serves") or [],
            "parts_note": sc.get("parts_note"),
            "status": "pending",
            "added_by": "route_optimiser",
            "added_reason": "Parts required by a later stop are not in van stock"}

    def _gen_routes(self, engineers: list, lockers: list, fleet: list) -> dict:
        """Today's round per engineer, then optimised for real.

        The stops are generated as DISPATCHED — booked in the order the contact
        centre took them, which is not the order they should be driven in. The
        optimiser then sequences them against live constraints and the difference
        between the two is what Transport Control reports as saved. Nothing here
        is drawn from a savings distribution: if the booked order was already
        good, the saving is small, and that is the honest answer.
        """
        routes = {}
        fuel_by_eng = {v["engineer_code"]: v["fuel_type"] for v in fleet}
        caz_by_eng = {v["engineer_code"]: v["caz_compliant"] for v in fleet}
        hours_by_eng = {v["engineer_code"]: v["hours_driven_today"] for v in fleet}

        for eng in engineers:
            if eng["job_status"] == "off_duty":
                continue
            skills = set(eng.get("skills") or [])
            n_stops = random.randint(2, 6)
            lat0, lon0 = eng["latitude"], eng["longitude"]
            postcode_prefix = eng["home_postcode"].split(" ")[0]
            stops = []
            hour, minute = 8, random.choice([0, 15, 30])

            for s in range(n_stops):
                job_type = self._draw_job_type(skills)
                spec = JOB_SPECS[job_type]
                lat = round(lat0 + rnd(-0.15, 0.15, 4), 4)
                lon = round(lon0 + rnd(-0.15, 0.15, 4), 4)
                minute += 30 + (spec.service_mins if s > 0 else 0)
                hour += minute // 60
                minute = minute % 60
                planned = f"{min(hour, 19):02d}:{minute:02d}"
                stop = {
                    "seq": s + 1,
                    "job_code": f"JOB-{random.randint(40000, 89999)}",
                    "postcode": f"{postcode_prefix}{random.randint(1, 9)} {random.randint(1,9)}{''.join(random.choices('ABDEFGHJLNPQRSTUWXYZ', k=2))}",
                    "latitude": lat,
                    "longitude": lon,
                    "job_type": job_type,
                    "job_label": spec.label,
                    "service_mins": spec.service_mins,
                    "planned_arrival": planned,
                    "priority": spec.priority,
                    # The customer's committed window — it does NOT move when we
                    # add a detour, which is exactly what makes a breach a breach.
                    "sla_deadline": _add_clock_mins(planned, spec.sla_slack_mins),
                    "required_skills": list(spec.required_skills),
                    "stop_kind": "job",
                    "status": "pending"}

                # Anything too big for a van or a locker is delivered two-man to
                # the address on the day. Most are booked; the ones that are not
                # are exactly the visits that will fail to fix first time.
                if any(p.handling == "bulky" for p in spec.parts):
                    if random.random() < 0.85:
                        stop["parts_delivery"] = {
                            "eta": _add_clock_mins(planned, random.choice([-45, -30, -15, 0, 20, 45])),
                            "status": random.choices(["delivered", "in_transit"],
                                                     weights=[0.55, 0.45])[0],
                            "service": "two_man"}
                stops.append(stop)

            code = eng["engineer_code"]
            fuel = fuel_by_eng.get(code, "diesel")

            # Sequence the booked round for real. Day-plan view: every stop still
            # ahead of us, starting from the engineer's base at first light.
            plan = routing.optimise_round(
                engineer=eng, route={"stops": stops}, lockers=lockers,
                severity="normal", fuel_type=fuel,
                caz_compliant=caz_by_eng.get(code, True),
                hours_driven_today=hours_by_eng.get(code, 0.0),
                now_min=routing.SHIFT_START_MIN)

            # Re-lay the day in the optimised order, then burn part of it down so
            # the round is genuinely mid-flight rather than untouched. Locker
            # collections go onto `stops` alongside the jobs — same shape the
            # resolution engine already uses when it inserts one — so the route
            # map and timeline draw them without knowing where they came from.
            by_code = {st["job_code"]: st for st in stops}
            ordered, placed = [], set()
            for sc in plan["sequence"]:
                if sc["kind"] == "job":
                    st = by_code.get(sc["ref"])
                    if st is None:
                        continue
                    # When we now expect to arrive. `sla_deadline` deliberately
                    # keeps the time the customer was promised — it does not move
                    # because we re-sequenced, which is what makes a breach real.
                    st["booked_arrival"] = st["planned_arrival"]
                    st["planned_arrival"] = sc["arrive"]
                    st["optimised_arrival"] = sc["arrive"]
                    st["parts_status"] = sc["parts_status"]
                    st["parts_ready"] = sc["parts_ready"]
                    st["parts_note"] = sc["parts_note"]
                    st["parts_lines"] = sc["parts_lines"]
                    ordered.append(st)
                    placed.add(st["job_code"])
                else:
                    ordered.append(self._collection_stop(sc))
            # A job the optimiser could not sequence is still booked on this
            # round, so it stays visible — but it is NOT part of the drive
            # sequence, because this engineer cannot legally work it. It carries
            # no projected arrival for the same reason: quoting one would be
            # inventing a time for a visit that is not going to happen. What the
            # customer was promised is kept on `booked_arrival`, which is the
            # figure that matters when somebody reallocates it.
            blocked_info = {j["job_code"]: j for j in plan["jobs_needing_reallocation"]}
            blocked = []
            for st in stops:
                if st["job_code"] in placed:
                    continue
                info = blocked_info.get(st["job_code"], {})
                st["status"] = "blocked"
                st["needs_reallocation"] = True
                st["blocked_reason"] = info.get("reason", "skill_gap")
                st["missing_skills"] = info.get("missing_skills", [])
                st["missing_skill_labels"] = info.get("missing_skill_labels", [])
                st["booked_arrival"] = st["planned_arrival"]
                st["planned_arrival"] = None
                blocked.append(st)
            ordered += blocked

            # Only stops the van will actually drive to can be burned down.
            drivable = [st for st in ordered if st["status"] != "blocked"]
            completed = random.randint(0, max(0, len(drivable) - 1))
            worked = 0
            for st in ordered:
                if st["status"] == "blocked":
                    continue
                st["status"] = ("completed" if worked < completed
                                else "next" if worked == completed else "pending")
                worked += 1
            for i, st in enumerate(ordered):
                st["seq"] = i + 1

            base, opt = plan["baseline"], plan["optimised"]
            routes[code] = {
                "engineer_code": code,
                "stops": ordered,
                "stops_total": len(ordered),
                "stops_completed": completed,
                # Booked on this round but not drivable by this engineer — the
                # reallocation queue, sized per round.
                "stops_blocked": len(blocked),
                # Locker pickups the round has to make. Kept off `stops` so every
                # per-job count in the app keeps counting jobs, but carried here
                # because they are real stops with real detours.
                "collections": [s for s in plan["sequence"] if s["kind"] == "collection"],
                # How far behind the round is running right now. Carried on the
                # route (not re-rolled per read) so an action that recovers
                # minutes actually recovers them.
                "delay_mins": 0,
                "delay_cause": None,
                "planned_miles": base["travel_miles"],
                "optimized_miles": opt["travel_miles"],
                "planned_travel_mins": base["travel_mins"],
                "optimized_travel_mins": opt["travel_mins"],
                "miles_saved": plan["miles_saved"],
                "mins_saved": plan["mins_saved"],
                "optimization_applied": plan["applied"],
                # The whole derivation, so the UI can answer "why?" without
                # recomputing anything and without inventing a rationale.
                "optimisation": plan}
        return routes

    # ── Live re-optimisation ─────────────────────────────────────────────────
    # The same optimiser the day was planned with, re-run against where the van
    # actually is, what is actually left, and the traffic that is actually on the
    # road. This is what makes it REAL-TIME rather than an overnight batch: a
    # round re-optimised at 14:20 in severe traffic is a different problem to the
    # one solved at 07:00, and it finds different answers.

    def reoptimise_round(self, engineer_code: str, apply: bool = False) -> dict:
        s = self._snapshot
        route = (s.get("engineer_routes") or {}).get(engineer_code)
        eng = next((e for e in s.get("engineer_locations", [])
                    if e["engineer_code"] == engineer_code), None)
        if not route or not eng:
            return {"error": "No active route for this engineer"}

        van = next((v for v in s.get("fleet_vehicles", [])
                    if v["engineer_code"] == engineer_code), None)
        stops = route.get("stops", [])
        # Only customer jobs go into the optimiser. A collection stop is an
        # OUTPUT of sequencing, not an input: the optimiser re-derives it from
        # what the remaining jobs still need. Feeding the old one back in would
        # have it scored as a job in its own right and a fresh collection added
        # beside it, so every re-run grew another pickup.
        #
        # Blocked stops ARE passed in, deliberately — a re-run is the moment to
        # re-check the accreditation, so one that is no longer a gap heals itself.
        remaining = [st for st in stops
                     if st.get("status") != "completed"
                     and st.get("stop_kind") != "collection"]
        # A collection a dispatcher inserted by hand is a decision, not a
        # derivation. It is held aside and put back at the head of the round.
        manual_collections = [st for st in stops
                              if st.get("stop_kind") == "collection"
                              and st.get("status") != "completed"
                              and st.get("added_by") not in (None, "route_optimiser")]
        if not remaining:
            return {"error": "Round complete — nothing left to sequence"}

        # Where the round stands on the clock: the last job it finished, plus
        # however far behind it is running. A delayed round re-optimises from the
        # delayed position, which is the whole point.
        delay = route.get("delay_mins") or 0
        done = [st for st in stops if st.get("status") == "completed"]
        if done:
            last = done[-1]
            now_min = (routing.to_minutes(last.get("planned_arrival"), routing.SHIFT_START_MIN)
                       + (last.get("service_mins") or 45) + delay)
        else:
            now_min = routing.SHIFT_START_MIN + delay

        # Bulky legs already in flight beat whatever the stop was generated with.
        deliveries = {}
        for mv in s.get("carrier_movements", []):
            if mv.get("linked_job_code") and mv.get("dest_type") == "job_site":
                deliveries[mv["linked_job_code"]] = {
                    "eta": mv.get("eta") or mv.get("promised_time"),
                    "status": mv.get("status")}

        # Parts already picked up this morning are aboard the van, whatever the
        # overnight stock list says.
        collected = {sku for st in stops
                     if st.get("stop_kind") == "collection" and st.get("status") == "completed"
                     for sku in (st.get("sku_codes") or [])}

        result = routing.optimise_round(
            engineer=eng, route={"stops": remaining},
            lockers=s.get("locker_status", []),
            severity=s.get("traffic_severity", "normal"),
            fuel_type=(van or {}).get("fuel_type", "diesel"),
            caz_compliant=(van or {}).get("caz_compliant", True),
            hours_driven_today=(van or {}).get("hours_driven_today", 0.0),
            now_min=now_min, deliveries=deliveries, collected=collected)

        result["engineer_name"] = eng.get("name")
        result["region"] = eng.get("region")
        result["registration"] = (van or {}).get("registration")
        result["engineer_skills"] = eng.get("skill_labels", [])
        result["delay_mins_before"] = delay
        result["applied_to_round"] = False

        if apply and result.get("applied"):
            self.apply_optimised_round(engineer_code, result,
                                       manual_collections=manual_collections)
            result["applied_to_round"] = True
        return result

    def apply_optimised_round(self, engineer_code: str, result: dict,
                              manual_collections: list | None = None) -> None:
        """Commit an optimised sequence back onto the live round."""
        route = (self._snapshot.get("engineer_routes") or {}).get(engineer_code)
        if not route:
            return
        stops = route.get("stops", [])
        done = [st for st in stops if st.get("status") == "completed"]
        by_code = {st.get("job_code"): st for st in stops if st.get("status") != "completed"}

        resequenced, placed = [], set()
        for sc in result.get("sequence", []):
            if sc["kind"] == "job":
                st = by_code.get(sc["ref"])
                if st is None:
                    continue
                # The arrival moves; the customer's committed deadline does not.
                st["planned_arrival"] = sc["arrive"]
                st["optimised_arrival"] = sc["arrive"]
                st["parts_status"] = sc["parts_status"]
                st["parts_ready"] = sc["parts_ready"]
                st["parts_note"] = sc["parts_note"]
                resequenced.append(st)
                placed.add(sc["ref"])
            else:
                resequenced.append(self._collection_stop(sc))
        # A hand-inserted collection goes back at the head of the round — the
        # dispatcher put it there for a reason the optimiser cannot see.
        resequenced = list(manual_collections or []) + resequenced

        for i, st in enumerate(resequenced):
            st["status"] = "next" if i == 0 else "pending"

        # Anything the optimiser could not place stays on the round rather than
        # vanishing — but out of the drive sequence and with no invented arrival.
        blocked_info = {j["job_code"]: j for j in result.get("jobs_needing_reallocation", [])}
        for code, st in by_code.items():
            if code in placed or st.get("stop_kind") == "collection":
                continue
            info = blocked_info.get(code, {})
            st["status"] = "blocked"
            st["needs_reallocation"] = True
            st["blocked_reason"] = info.get("reason", "skill_gap")
            st["missing_skills"] = info.get("missing_skills", [])
            st["missing_skill_labels"] = info.get("missing_skill_labels", [])
            st.setdefault("booked_arrival", st.get("planned_arrival"))
            st["planned_arrival"] = None
            resequenced.append(st)

        route["stops"] = done + resequenced
        self._resequence(route)
        route["collections"] = [sc for sc in result.get("sequence", []) if sc["kind"] == "collection"]
        route["optimized_miles"] = result["optimised"]["travel_miles"]
        route["optimized_travel_mins"] = result["optimised"]["travel_mins"]
        route["miles_saved"] = round((route.get("miles_saved") or 0) + result["miles_saved"], 1)
        route["mins_saved"] = (route.get("mins_saved") or 0) + result["mins_saved"]
        route["optimization_applied"] = True
        route["optimisation"] = result
        # The geometry cached for the map was drawn for the old sequence.
        route["_road_cache"] = None

    def complete_walkaround(self, registration: str, completed_by: str) -> dict:
        for v in self._snapshot.get("fleet_vehicles", []):
            if v["registration"] == registration:
                v["walkaround_completed"] = True
                v["walkaround_time"] = datetime.now(timezone.utc).strftime("%H:%M")
                return {"registration": registration, "walkaround_completed": True,
                        "completed_by": completed_by, "walkaround_time": v["walkaround_time"]}
        return {"error": "Vehicle not found"}

    def resolve_vehicle_defect(self, registration: str, defect_id: str, resolved_by: str) -> dict:
        for v in self._snapshot.get("fleet_vehicles", []):
            if v["registration"] == registration:
                for d in v["defects"]:
                    if d["defect_id"] == defect_id:
                        d["status"] = "resolved"
                        d["resolved_by"] = resolved_by
                if not any(d["severity"] == "major" and d["status"] == "open" for d in v["defects"]):
                    v["vor"] = False
                return {"registration": registration, "defect_id": defect_id, "status": "resolved"}
        return {"error": "Vehicle not found"}

    def _assign_lockers(self, engineers: list, lockers: list) -> None:
        """Give every engineer a home ByBox site — the forward stock location
        their overnight wave is staged to. Without this the optimiser resolves
        each part to whatever locker is nearest that particular job and sends one
        engineer round four different sites in a morning, which nobody does."""
        by_region: dict[str, list] = {}
        for lk in lockers:
            by_region.setdefault(lk["region"], []).append(lk)
        for eng in engineers:
            pool = by_region.get(eng["region"]) or lockers
            if not pool:
                continue
            home = min(pool, key=lambda lk: routing.road_miles(
                eng["latitude"], eng["longitude"], lk["latitude"], lk["longitude"]))
            eng["assigned_locker_code"] = home["bybox_site_code"]
            eng["locker_assignments"] = [{
                "bybox_site_code": home["bybox_site_code"],
                "name": home["name"],
                "postcode": home["postcode"],
                "pre_8am_delivered": home["pre_8am_delivered"]}]

    def _gen_lockers(self) -> list:
        lockers = []
        for i in range(500):
            region = random.choice(UK_REGIONS)
            fill = rnd(10, 90)
            pre_8am = random.random() > 0.02
            lockers.append({
                "bybox_site_code": f"BBX-{1000 + i:05d}",
                "name": f"ByBox {region} Site {i+1}",
                "region": region,
                "postcode": rand_postcode(region),
                "latitude": round(self._REGION_CENTRES.get(region, (52.5, -1.5))[0] + rnd(-0.18, 0.18, 4), 4),
                "longitude": round(self._REGION_CENTRES.get(region, (52.5, -1.5))[1] + rnd(-0.18, 0.18, 4), 4),
                "fill_pct": fill,
                "total_slots": random.choice([30, 50, 80]),
                "pre_8am_delivered": pre_8am,
                "last_delivery_at": (datetime.now(timezone.utc) - timedelta(hours=rnd(1, 8))).isoformat(),
                "status": "alert" if (fill > 85 or not pre_8am) else "healthy",
                "items_available": random.randint(2, 25)},)
        return lockers

    def _gen_suppliers(self) -> list:
        result = []
        for s in SUPPLIER_DATA:
            otif = rnd(max(50, s["otif_base"] - 8), min(99, s["otif_base"] + 3))
            risk = min(100, max(0, round(otif - rnd(-5, 5))))
            ariba_status = random.choices(
                ["compliant", "expiring_30d", "expired"],
                weights=[0.8, 0.15, 0.05]
            )[0]
            # Order volume tracks reliability — buyers naturally route more
            # volume to dependable suppliers, so a chronic under-performer
            # carries less weight in the network-wide OTIF than a flat
            # per-supplier average would give it. The random band is kept
            # narrow relative to the base-driven component so this signal
            # isn't swamped by independent noise.
            orders_placed = max(20, round(s["otif_base"] * 1.8 + rnd(-15, 15)))
            orders_on_time = round(orders_placed * otif / 100)
            result.append({
                **s,
                "otif_score": otif,
                "composite_risk_score": risk,
                "ariba_compliance_status": ariba_status,
                "sedex_risk_level": random.choice(["low", "low", "medium", "high"]),
                "financial_health_flag": random.random() < 0.05,
                "geopolitical_risk_flag": s.get("country_code") in ["JP", "KR", "CN"],
                "week_start": date.today().isoformat(),
                "orders_placed": orders_placed,
                "orders_on_time": orders_on_time},)
        return result

    # Freight carriers and the in-flight states a dispatched PO can be in. Every
    # one of these still means "goods are on the water/road and not yet booked
    # in" — the PO stays `in_transit` until goods receipt closes it.
    _CARRIERS = ["DHL Express", "Kuehne+Nagel", "DSV Road", "Geodis", "DB Schenker"]
    _SHIPMENT_STATUSES = ["in_transit", "in_transit", "in_transit", "delayed", "at_port", "customs"]
    _COUNTRY_COORDS = {
        "GB": (52.3555, -1.1743), "JP": (35.6762, 139.6503),
        "BE": (50.5039, 4.4699), "KR": (35.9078, 127.7669),
        "NL": (52.1326, 5.2913), "CH": (46.8182, 8.2275),
    }

    def _gen_shipments(self, now: datetime, purchase_orders: list) -> list:
        """Inbound freight, derived from the PO book.

        Shipments used to be invented alongside POs — their own random suppliers,
        their own random destinations, no document linking the two. The result was
        a supplier that showed five live inbound shipments on its risk scorecard
        and zero purchase orders in the demand queue, because the two lists were
        never talking about the same thing.

        A shipment is now what it is in the real process: the physical leg of a PO
        that has been dispatched. One shipment per `in_transit` PO, carrying that
        PO's number, supplier, destination and quantity. POs still in draft or
        confirmed have not shipped yet, so they have no freight against them."""
        return [self._shipment_for_po(po, now)
                for po in purchase_orders if po.get("status") == "in_transit"]

    def _shipment_for_po(self, po: dict, now: datetime, carrier: str | None = None) -> dict:
        """Build the inbound shipment for one dispatched PO.

        The single place a shipment is created, so the PO ↔ shipment link cannot
        drift: every caller (baseline seed and scenarios alike) goes through here."""
        supplier = next((sp for sp in SUPPLIER_DATA if sp["supplier_code"] == po.get("supplier_code")), None)
        country = (supplier or {}).get("country_code", "GB")
        wh = next((w for w in WAREHOUSES_DATA if w["code"] == po.get("warehouse_code")),
                  next(w for w in WAREHOUSES_DATA if w["code"] == NDC_CODE))

        delay = rnd(-2, 12) if random.random() < 0.3 else 0
        # The PO's promised date is the shipment's scheduled arrival — the two
        # documents cannot disagree about when the goods land.
        scheduled = self._parse_dt(po.get("expected_delivery")) or (now + timedelta(hours=rnd(4, 72)))

        origin_lat, origin_lng = self._COUNTRY_COORDS.get(country, (51.5074, -0.1278))
        origin_lat += rnd(-0.5, 0.5)
        origin_lng += rnd(-0.5, 0.5)
        dest_lat, dest_lng = wh["latitude"], wh["longitude"]

        progress = random.random() * 0.9 + 0.05
        curr_lat = origin_lat + (dest_lat - origin_lat) * progress
        curr_lng = origin_lng + (dest_lng - origin_lng) * progress

        self._shipment_counter += 1
        shipment = {
            "shipment_ref": f"SHP-{2026000 + self._shipment_counter}",
            "po_number": po.get("po_number"),
            "sku_code": po.get("sku_code"),
            "description": po.get("description"),
            "supplier_code": po.get("supplier_code"),
            "supplier_name": po.get("supplier_name"),
            "carrier": carrier or random.choice(self._CARRIERS),
            "origin_country": country,
            "destination_warehouse": wh["code"],
            "scheduled_arrival": scheduled.isoformat(),
            "predicted_arrival": (scheduled + timedelta(hours=delay)).isoformat(),
            "delay_hours": max(0, delay),
            "status": random.choice(self._SHIPMENT_STATUSES),
            "alert_raised": delay > 4,
            "sku_count": 1,                                   # one PO line, one part
            "total_units": po.get("quantity") or random.randint(100, 2000),
            "cost": random.randint(1200, 5800),               # freight cost, not goods value
            "origin_lat": origin_lat,
            "origin_lng": origin_lng,
            "dest_lat": dest_lat,
            "dest_lng": dest_lng,
            "current_lat": curr_lat,
            "current_lng": curr_lng,
            "traffic_status": "heavy_traffic" if delay > 4 else random.choice(["heavy_traffic", "normal", "fast"]),
        }

        # Generate AI optimization suggestion for delayed or high-cost shipments
        if shipment["delay_hours"] > 0 or shipment["cost"] > 4000 or (random.random() < 0.2):
            shipment["ai_optimization"] = {
                "suggested_carrier": random.choice([c for c in self._CARRIERS if c != shipment["carrier"]]),
                "cost_saving": random.randint(200, 900),
                "time_saving_hours": random.randint(4, 24),
                "reason": random.choice([
                    "Bypasses current congestion at origin port.",
                    "Consolidates with an existing less-than-truckload (LTL) shipment.",
                    "Utilizes newly available expedited air freight capacity.",
                    "Reroutes to avoid severe weather system in transit path."
                ])
            }
        return shipment

    @staticmethod
    def _parse_dt(value: Any) -> datetime | None:
        """Best-effort ISO parse — snapshots round-trip through JSON, so a
        timestamp can come back as a string."""
        if isinstance(value, datetime):
            return value
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value)
            except ValueError:
                return None
        return None

    def _gen_exceptions(self, now: datetime) -> list:
        templates = [
            {"priority": "P2", "category": "critical_stockout",
             "title": "Critical SKU Stockout: Diverter Valve (Vaillant ecoTEC)",
             "description": "Diverter valve SKU-BLR-001 has reached zero stock at Leicester NDC. 847 engineer jobs are at risk over the next 48 hours. Secondary hubs hold partial cover for ~180 vans.",
             "impacted_engineer_count": 234, "estimated_resolution_hours": 48,
             "impacted_skus": ["SKU-BLR-001"],
             "scenario_id": "p2_stockout",
             "recommended_action": "Raise emergency PO via SAP Ariba (target 48hr delivery). Initiate inter-engineer van transfers and alert 5 regional trade counter branches.",
             "automated_action_taken": "Van stock swept network-wide and remaining units redirected to P1 and vulnerable-customer jobs. Sister-hub lateral rebalance checked before buying. Emergency PO PO-DEMO-EMG drafted in SAP Ariba; transfer broadcast sent to 412 engineers.",
             "alert_channels_notified": {"in_app": True, "email": True, "sms": True, "slack": True},
             "recurrence_count": 2},
            {"priority": "P3", "category": "locker_failure",
             "title": "Pre-8AM Locker Delivery Gap: 12 Sites (East Midlands)",
             "description": "12 ByBox sites in East Midlands did not receive pre-8AM delivery. 67 engineers are unable to collect parts before first appointment.",
             "impacted_engineer_count": 67, "estimated_resolution_hours": 4,
             "impacted_skus": [],
             "scenario_id": "locker_outage",
             "recommended_action": "Dispatch emergency courier runs to the 12 affected sites. Notify engineers of revised 09:30 collection window via SMS.",
             "automated_action_taken": "Affected jobs identified and stock rerouted from the nearest holding site. Uncoverable jobs rescheduled before engineer travel. Emergency courier re-run booked; 67 engineers notified in-app.",
             "alert_channels_notified": {"in_app": True, "email": True, "sms": False, "slack": False},
             "recurrence_count": 3},
            {"priority": "P3", "category": "supplier_risk",
             "title": "Mitsubishi HVAC OTIF at 58% — Heat Pump Supply at Risk",
             "description": "MIT_HV OTIF has fallen to 58% for the third consecutive week. Heat pump installation programme is at risk. Daikin and Samsung flagged as contingency suppliers.",
             "impacted_engineer_count": 0, "estimated_resolution_hours": 168,
             "impacted_skus": ["SKU-HP-001"],
             "scenario_id": "supplier_otif_dip",
             "recommended_action": "Escalate to MIT_HV account manager. Engage Daikin Europe and Samsung HA as contingency and initiate 90-day safety stock build.",
             "automated_action_taken": "Open PO delivery promises re-validated and supplier placed on the active OTIF watch-list. Contingency suppliers queued; Daikin Europe and Samsung HA contacted for emergency capacity.",
             "alert_channels_notified": {"in_app": True, "email": True, "sms": False, "slack": True},
             "recurrence_count": 1},
            {"priority": "P3", "category": "shipment_delay",
             "title": "Navien NCB-E Heat Exchangers: 8hr ETA Deviation",
             "description": "SHP-2026022 from Navien UK delayed by 8.2hrs due to port congestion at Tilbury. 45 engineers have jobs requiring this part today.",
             "impacted_engineer_count": 45, "estimated_resolution_hours": 10,
             "impacted_skus": ["SKU-BLR-002"],
             "scenario_id": "shipment_delay",
             "recommended_action": "Reroute available stock from Manchester Hub to affected engineers. Notify 45 engineers via SMS of revised ETA.",
             "automated_action_taken": None,
             "alert_channels_notified": {"in_app": True, "email": True, "sms": False, "slack": False},
             "recurrence_count": 1},
        ]
        # A usual control-tower day: the serious P2 is already resolved history,
        # but a couple of routine P3s are still being worked.
        baseline_status = ["resolved", "open", "acknowledged", "open"]
        exceptions = []
        for i, tmpl in enumerate(templates):
            self._exception_counter += 1
            status = baseline_status[i % len(baseline_status)]
            exc = {
                **tmpl,
                "exception_code": f"EXC-{2026000 + self._exception_counter:04d}",
                "status": status,
                "created_at": (now - timedelta(hours=rnd(2, 10) if status != "resolved" else rnd(12, 72))).isoformat(),
                "updated_at": (now - timedelta(hours=rnd(0.5, 2))).isoformat()}
            if status == "resolved":
                exc.update({
                    "resolved_by": "system",
                    "resolved_at": (now - timedelta(hours=rnd(1, 12))).isoformat(),
                    "root_cause": "Resolved prior to current shift"},)
            elif status == "acknowledged":
                exc["acknowledged_by"] = "logistics.ops@abc.com"
                exc["acknowledged_at"] = (now - timedelta(hours=rnd(1, 4))).isoformat()
            exceptions.append(exc)
        return exceptions

    # Curated baseline quantities — these carry the demo storyline (BLR-004 is
    # deliberately overstocked for the excess narrative).
    _CURATED_ON_HAND = {
        "SKU-BLR-001": 842, "SKU-BLR-002": 624, "SKU-BLR-003": 456,
        "SKU-BLR-004": 560, "SKU-BLR-005": 1230, "SKU-HP-001": 1200,
        "SKU-HP-002": 1020, "SKU-SM-001": 600, "SKU-EV-001": 720}

    def _gen_inventory(self, signals: dict | None = None) -> list:
        """Build a position for every SKU in the catalogue. Curated SKUs keep their
        scripted quantities; the long tail gets a deterministic health spread
        (~85% healthy, ~8% low, ~4% critical, plus a slice of overstock) so the
        worklist, DRP and excess workflows are exercised at real scale."""
        rng = random.Random(99260718)
        scores = _driver_scores(signals or {})   # score the signals once for the whole catalogue
        result = []
        for sku_code in SKU_CONFIG:
            cfg = SKU_CONFIG[sku_code]
            desc = SKU_DESCRIPTION.get(sku_code, sku_code)
            cat = SKU_CATEGORY.get(sku_code, "boiler")
            if sku_code in self._CURATED_ON_HAND:
                on_hand = self._CURATED_ON_HAND[sku_code]
            else:
                # Size against the SAME order-up-to target the RAG and excess rules
                # use — i.e. demand-adjusted, not base — otherwise seasonally
                # suppressed demand makes half the catalogue look overstocked.
                mult, _ = _sku_demand_multiplier(sku_code, signals or {}, scores)
                daily_adj = cfg["daily_consumption"] * mult
                cover = cfg["lead_time_days"] + cfg["review_period_days"]
                # on-hand that puts `available` exactly on the order-up-to target
                target = (_safety_stock(sku_code) + cover * daily_adj) / 0.85
                roll = rng.random()
                if roll < 0.012:
                    factor = 0.0                          # true stockout
                elif roll < 0.045:
                    factor = rng.uniform(0.10, 0.35)      # critical
                elif roll < 0.125:
                    factor = rng.uniform(0.55, 0.92)      # low / inside reorder window
                elif roll < 0.215:
                    factor = rng.uniform(1.45, 1.90)      # overstocked
                else:
                    factor = rng.uniform(0.95, 1.15)      # healthy
                on_hand = max(0, int(round(target * factor)))
            result.append(self._build_inventory_item(sku_code, desc, cat, on_hand, signals or {}, scores))
        self._apply_inventory_analytics(result)
        return result

    def _apply_inventory_analytics(self, items: list):
        """Best-in-class planning analytics layered onto every inventory row, all
        sourced from the one deterministic PLANNING_POLICY so the segment, the
        service target and the safety stock always agree:
          · ABC × XYZ segmentation with a differentiated service target
          · the statistical safety-stock derivation, exposed for explainability
          · working-capital value and cost-to-serve (holding / stockout / GMROI)
          · excess-stock detection against the order-up-to target
          · a stable per-SKU forecast-quality record (MAPE / bias / FVA)."""
        for it in items:
            sku = it["sku_code"]
            pol = PLANNING_POLICY.get(sku, {})
            cfg = SKU_CONFIG.get(sku, {})
            unit_cost = pol.get("unit_cost_gbp", cfg.get("unit_cost_gbp", 50))
            cv = pol.get("demand_cv", cfg.get("demand_cv", 0.4))

            daily_adj = it.get("daily_consumption_adjusted") or 1
            available = it.get("quantity_available", 0)
            on_hand = it.get("quantity_on_hand", 0)
            max_stock = it["safety_stock_level"] + round((it["lead_time_days"] + it["review_period_days"]) * daily_adj)
            excess_units = max(0, available - max_stock)
            is_excess = it.get("rag_status") == "G" and available > round(max_stock * 1.25)

            stock_value = round(on_hand * unit_cost)
            annual_holding = round(stock_value * HOLDING_COST_RATE_PA)   # £/yr to carry current stock
            annual_cogs = round(cfg.get("daily_consumption", 10) * 365 * unit_cost)
            gmroi = round(annual_cogs * 0.28 / stock_value, 2) if stock_value else None  # gross-margin return on inventory

            it.update({
                "abc_class": pol.get("abc_class", "C"),
                "xyz_class": pol.get("xyz_class", "Y"),
                "segment": pol.get("segment", "CY"),
                "demand_cv": cv,
                "service_level_target_pct": pol.get("service_level_target_pct", 95.0),
                "unit_cost_gbp": unit_cost,
                "annual_value_gbp": pol.get("annual_value_gbp", annual_cogs),
                "stock_value_gbp": stock_value,
                "annual_holding_cost_gbp": annual_holding,
                "gmroi": gmroi,
                "excess_units": excess_units if is_excess else 0,
                "excess_value_gbp": round(excess_units * unit_cost) if is_excess else 0,
                "is_excess": is_excess,
                # Safety-stock derivation, surfaced so the buffer can answer "why?"
                # Compact per-site RAG so the network table keeps its site-health
                # column without shipping the full nested breakdown in list rows.
                "site_rag": {w["warehouse_code"]: w["rag_status"] for w in it.get("by_warehouse", [])},
                "safety_stock_static": pol.get("safety_stock_static"),
                "safety_stock_z": pol.get("z"),
                "sigma_daily": pol.get("sigma_daily"),
                "sigma_lead_days": pol.get("sigma_lead_days"),
                "lead_time_cv": pol.get("lead_time_cv"),
                "protection_days": pol.get("protection_days"),
                "primary_supplier": pol.get("primary_supplier")},)
            # Forecast quality is a slowly-moving property — generate once and keep
            if "forecast_quality" not in it:
                it["forecast_quality"] = self._gen_forecast_quality(sku, cv)

    def _gen_forecast_quality(self, sku_code: str, cv: float) -> dict:
        """Per-SKU forecast-performance record. MAPE scales with demand
        volatility (XYZ); bias is a small signed error; FVA is the accuracy
        the stat model adds over a naive last-period forecast."""
        if cv <= 0.25:
            mape = rnd(5, 9)
        elif cv <= 0.50:
            mape = rnd(11, 18)
        else:
            mape = rnd(19, 29)
        bias = rnd(-6, 6)
        daily = SKU_CONFIG.get(sku_code, {}).get("daily_consumption", 10)
        weekly = []
        for w in range(8, 0, -1):
            actual = round(daily * 7 * rnd(0.82, 1.22, 2))
            err = actual * (mape / 100) * rnd(0.4, 1.4, 2)
            forecast = round(actual + err * (1 if random.random() < 0.5 + bias / 25 else -1))
            weekly.append({"week": f"W-{w}", "forecast": forecast, "actual": actual})
        return {
            "mape_pct": mape,
            "bias_pct": bias,
            "fva_pct": rnd(4, 14),
            "weekly": weekly}

    def _build_inventory_item(self, sku_code: str, desc: str, cat: str, on_hand: int,
                              signals: dict, scores: dict | None = None) -> dict:
        cfg = SKU_CONFIG.get(sku_code, {"daily_consumption": 10, "safety_stock": 100, "lead_time_days": 7, "review_period_days": 7})
        daily_base    = cfg["daily_consumption"]
        safety_stock  = _safety_stock(sku_code)   # statistical, from the planning policy
        lead_time     = cfg["lead_time_days"]
        review        = cfg["review_period_days"]
        demand_mult, demand_drivers = _sku_demand_multiplier(sku_code, signals or {}, scores)
        daily_adj     = round(daily_base * demand_mult, 2)
        reserved      = min(on_hand, round(on_hand * 0.15))
        available     = on_hand - reserved
        dos           = round(on_hand / daily_adj, 1) if daily_adj > 0 else 999.9
        reorder_point = safety_stock + round((lead_time + review) * daily_adj)
        target_qty    = self._calc_target_order_qty(available, safety_stock, lead_time, review, daily_adj)

        if on_hand == 0:
            rag = "R"
        elif dos < lead_time:
            rag = "R"
        elif available < safety_stock or dos < (lead_time + review):
            rag = "A"
        else:
            rag = "G"

        item = {
            "sku_code": sku_code,
            "description": desc,
            "category": cat,
            "warehouse_code": "NETWORK",  # aggregate row — see by_warehouse for site detail
            "quantity_on_hand": on_hand,
            "quantity_reserved": reserved,
            "quantity_available": available,
            "safety_stock_level": safety_stock,
            "reorder_point": reorder_point,
            "days_of_supply": dos,
            "daily_consumption_base": daily_base,
            "daily_consumption_adjusted": daily_adj,
            "demand_uplift_applied": demand_mult,
            "demand_drivers": demand_drivers,
            "lead_time_days": lead_time,
            "review_period_days": review,
            "target_order_qty": target_qty,
            "rag_status": rag}
        item["by_warehouse"] = self._distribute_across_network(item)
        return item

    def _distribute_across_network(self, item: dict) -> list:
        """Split a SKU's network position across the NDC and regional hubs.

        Allocation fractions are per-category and deterministic, so scenario
        mutations to the network on-hand (e.g. stockouts) flow through to every
        site consistently on recompute. Hubs get their fractional share; the
        NDC absorbs the rounding remainder as the strategic buffer.
        Per-site RAG uses the site's own replenishment horizon: supplier lead
        time at the NDC, trunker transfer lead time at hubs."""
        alloc = WAREHOUSE_ALLOCATION.get(item["category"], _DEFAULT_ALLOCATION)
        total_oh = item["quantity_on_hand"]
        daily_adj = item["daily_consumption_adjusted"]
        policy = PLANNING_POLICY.get(item["sku_code"], {})
        z = policy.get("z", 1.65)
        cv = policy.get("demand_cv", 0.4)

        hub_oh = {code: round(total_oh * alloc.get(code, 0)) for code in HUB_CODES}
        ndc_oh = max(0, total_oh - sum(hub_oh.values()))

        result = []
        for wh in WAREHOUSES_DATA:
            code = wh["code"]
            is_ndc = code == NDC_CODE
            frac = alloc.get(code, 0)
            oh = ndc_oh if is_ndc else hub_oh[code]
            daily = round(daily_adj * frac, 2)
            reserved = min(oh, round(oh * 0.15))
            available = oh - reserved
            dos = round(oh / daily, 1) if daily > 0 else 999.9
            if is_ndc:
                lead = item["lead_time_days"]
                review = item["review_period_days"]
                lead_cv = policy.get("lead_time_cv", 0.1)
                source = "suppliers"
            else:
                lead = HUB_TRANSFER_LEAD_DAYS.get(code, 2)
                review = HUB_REVIEW_DAYS
                lead_cv = 0.10                       # internal trunker moves are reliable
                source = "Leicester NDC"
            # Per-site statistical safety stock: hubs replenish fast off the NDC so
            # they carry a lean buffer; the NDC pools the strategic buffer against
            # the long, less-reliable supplier lead. This is the risk-pooling effect.
            sigma_d = cv * daily
            sigma_l = lead * lead_cv
            safety = int(round(z * math.sqrt((lead + review) * sigma_d ** 2 + (daily ** 2) * sigma_l ** 2)))
            if oh == 0:
                rag = "R"
            elif dos < lead:
                rag = "R"
            elif available < safety or dos < (lead + review):
                rag = "A"
            else:
                rag = "G"
            # Order-up-to target for this site (supplier PO for NDC, transfer for hubs)
            max_stock = safety + round((lead + review) * daily)
            replen_qty = max(0, max_stock - available)
            replen_qty = (replen_qty + 4) // 5 * 5 if replen_qty > 0 else 0
            result.append({
                "warehouse_code": code,
                "warehouse_name": wh["name"],
                "role": "ndc" if is_ndc else "hub",
                "replenished_from": source,
                "demand_share_pct": round(frac * 100),
                "quantity_on_hand": oh,
                "quantity_reserved": reserved,
                "quantity_available": available,
                "safety_stock_level": safety,
                "daily_consumption": daily,
                "days_of_supply": dos,
                "replenishment_lead_days": lead,
                "review_period_days": review,
                "rag_status": rag,
                "replenishment_qty": replen_qty if rag != "G" else 0},)
        return result

    def _calc_target_order_qty(self, available: int, safety_stock: int,
                                lead_time_days: int, review_period_days: int,
                                daily_demand: float) -> int:
        """Order-Up-To formula: order enough to reach max stock = safety_stock + (LT + RP) × demand."""
        max_stock = safety_stock + round((lead_time_days + review_period_days) * daily_demand)
        qty = max(0, max_stock - available)
        return (qty + 9) // 10 * 10 if qty > 0 else 0  # round up to nearest 10

    def _get_demand_uplift(self) -> float:
        return self._snapshot.get("demand_signals", {}).get("weather", {}).get("demand_uplift_factor", 1.0)

    def _recompute_inventory_dos(self):
        """Recompute all derived inventory fields from on_hand + the live demand
        signals. Demand is now sensed per-SKU (each signal moves only the SKUs it
        drives) and safety stock is the statistical buffer from the planning policy."""
        signals = self._snapshot.get("demand_signals", {})
        scores = _driver_scores(signals)   # score the signals once, not per SKU
        for item in self._snapshot.get("inventory_positions", []):
            sku = item["sku_code"]
            cfg = SKU_CONFIG.get(sku)
            if not cfg:
                continue
            on_hand      = item["quantity_on_hand"]
            daily_base   = cfg["daily_consumption"]
            safety_stock = _safety_stock(sku)
            lead_time    = cfg["lead_time_days"]
            review       = cfg["review_period_days"]
            demand_mult, demand_drivers = _sku_demand_multiplier(sku, signals, scores)
            daily_adj    = round(daily_base * demand_mult, 2)
            reserved     = min(on_hand, round(on_hand * 0.15))
            available    = on_hand - reserved
            dos          = round(on_hand / daily_adj, 1) if daily_adj > 0 else 999.9
            reorder_point = safety_stock + round((lead_time + review) * daily_adj)
            target_qty    = self._calc_target_order_qty(available, safety_stock, lead_time, review, daily_adj)

            if on_hand == 0:
                rag = "R"
            elif dos < lead_time:
                rag = "R"
            elif available < safety_stock or dos < (lead_time + review):
                rag = "A"
            else:
                rag = "G"

            item.update({
                "warehouse_code":             "NETWORK",
                "quantity_reserved":          reserved,
                "quantity_available":         available,
                "safety_stock_level":         safety_stock,
                "reorder_point":              reorder_point,
                "days_of_supply":             dos,
                "daily_consumption_base":     daily_base,
                "daily_consumption_adjusted": daily_adj,
                "demand_uplift_applied":      demand_mult,
                "demand_drivers":             demand_drivers,
                "lead_time_days":             lead_time,
                "review_period_days":         review,
                "target_order_qty":           target_qty,
                "rag_status":                 rag},)
            item["by_warehouse"] = self._distribute_across_network(item)
        self._apply_inventory_analytics(self._snapshot.get("inventory_positions", []))

    # SKU → preferred supplier for automatic replenishment
    _SKU_SUPPLIER = {
        "SKU-BLR-001": "VAI_UK", "SKU-BLR-002": "NAV_UK", "SKU-BLR-003": "VAI_UK",
        "SKU-BLR-004": "WOL_UK", "SKU-BLR-005": "WOL_UK",
        "SKU-HP-001": "MIT_HV", "SKU-HP-002": "DAI_EU",
        "SKU-SM-001": "LAND_UK", "SKU-EV-001": "ALF_NL"}

    # Batch cap keeps DRP transfer automation sane at catalogue scale. Auto PO
    # raising no longer has one of its own here — see the note below.
    _AUTO_TRANSFER_MAX_PER_TICK = 12

    # `auto_raise_critical_pos` used to live here: an unconditional, ungoverned
    # loop that emergency-raised a PO for every Red SKU on every tick, regardless
    # of the master AI switch, the replenishment capability's autonomy setting,
    # or any guardrail. That directly contradicted the action catalogue, which
    # marks emergency POs `autonomy="human"` — always a human decision, because
    # they carry an unplanned freight premium (see `dmd.raise_po_emergency` in
    # `app.synthetic.actions`). The bypass was silently auto-executing exactly
    # the class of action policy says must never self-execute.
    #
    # Real auto-raising now runs through the one path everything else in the
    # product does: `agent_engine._gen_replenishment` turns every Red/Amber
    # position into a governed recommendation, and `agent_engine.
    # run_autonomous_cycle` (ticked from `agent_autonomy_tick` in `main.py`,
    # every `TICK_INTERVAL_S`) auto-executes only the ones whose class, value and
    # confidence clear their gates — so a standard PO under the auto-approve
    # ceiling raises itself, and an emergency one waits in the approvals queue /
    # Ask ATLAS for a human, exactly as the rest of the fleet's autonomy works.

    # Seeded PO population by status. Only `in_transit` POs have physically
    # shipped, so that slice also sizes the inbound freight board — see
    # _gen_shipments, which builds exactly one shipment per in-transit PO.
    _PO_SEED_MIX = (
        ("draft", 6),
        ("confirmed", 10),
        ("in_transit", 20),
    )

    def _supplier_sku_pool(self, inventory: list) -> dict:
        """SKU → supplier ownership, read back off the catalogue.

        `primary_supplier` on an inventory row is the canonical sourcing link
        (it's what the reference-data endpoint builds `suppliers_by_category`
        from), so sourcing PO lines from here guarantees a PO can never name a
        part its supplier doesn't sell."""
        pool: dict[str, list] = {}
        for item in inventory:
            code = item.get("primary_supplier")
            if code:
                pool.setdefault(code, []).append(item)
        return pool

    def _gen_purchase_orders(self, now: datetime, inventory: list) -> list:
        """Seed the supplier PO book. Two invariants hold here and the rest of
        the module leans on both:

          · every PO delivers into the NDC. This is a two-echelon network —
            suppliers deliver to Leicester, hubs are replenished from Leicester
            by internal transfer. POs used to pick a random warehouse, so most
            of the queue contradicted the model (and its own column header).
          · every PO names a real SKU that this supplier actually sources, with
            a quantity. Without those, the PO was invisible to every downstream
            consumer that asks "what inbound cover does this part have?".

        Suppliers are dealt round-robin so each one has a real book behind the
        PO-queue filter and the risk-scorecard deep-link, rather than a random
        draw that leaves some suppliers with nothing to show."""
        pool = self._supplier_sku_pool(inventory)
        suppliers = [sp for sp in SUPPLIER_DATA if pool.get(sp["supplier_code"])]
        if not suppliers:
            return []

        status_plan = [st for st, n in self._PO_SEED_MIX for _ in range(n)]
        random.shuffle(status_plan)

        pos = []
        for i, status in enumerate(status_plan):
            supplier = suppliers[i % len(suppliers)]
            # Half the book is the curated hero parts where the supplier has any,
            # so the storyline SKUs carry real inbound cover on the projection
            # panel; the rest is drawn from that supplier's long tail.
            catalogue = pool[supplier["supplier_code"]]
            heroes = [it for it in catalogue if it["sku_code"] in CURATED_SKUS]
            item = random.choice(heroes) if heroes and random.random() < 0.5 else random.choice(catalogue)
            po_type = random.choices(["standard", "emergency", "auto_replenishment"], weights=[0.6, 0.2, 0.2])[0]

            # Order cover: lead time + review period, the classic order-up-to
            # horizon, capped so a 98-day heat-pump lead doesn't buy a year of
            # stock. Emergencies buy the gap, not the cycle.
            lead = int(item.get("lead_time_days") or 7)
            cover = min(lead + int(item.get("review_period_days") or 7), 28)
            daily = float(item.get("daily_consumption_base") or 5)
            qty = max(5, int(round(daily * cover * (0.4 if po_type == "emergency" else 1.0) / 5.0)) * 5)
            unit_cost = item.get("unit_cost_gbp") or 50

            # Placement is back-dated by how far through its lead time the order
            # is: a draft was raised today, an in-transit PO is most of the way
            # there. Promised delivery is then ordered_at + the SKU's real lead
            # time, so the queue's "days to delivery" column means something.
            # (uniform, not rnd() — rnd rounds to 1dp, which would flatten these
            # small fractions into the same couple of values)
            elapsed = {"draft": random.uniform(0.0, 0.05),
                       "confirmed": random.uniform(0.05, 0.4)}.get(status, random.uniform(0.5, 0.9))
            ordered_at = now - timedelta(days=lead * elapsed)
            expected = max(ordered_at + timedelta(days=lead), now + timedelta(hours=8))

            pos.append({
                "po_number": f"PO-{2026000 + i}",
                "sku_code": item["sku_code"],
                "description": item.get("description"),
                "supplier_code": supplier["supplier_code"],
                "supplier_name": supplier["name"],
                "warehouse_code": NDC_CODE,
                "po_type": po_type,
                "quantity": qty,
                "status": status,
                "total_value_gbp": round(qty * unit_cost, 2),
                "is_auto_generated": po_type == "auto_replenishment",
                "ariba_checked": random.random() > 0.1,
                "ordered_at": ordered_at.isoformat(),
                "expected_delivery": expected.isoformat()},)
        return pos

    # ─────────────────────────────────────────────
    # STOCK TRANSFERS (NDC → regional hubs)
    # ─────────────────────────────────────────────

    # Target STO population by status. Includes the terminal states (delivered,
    # cancelled) as well as the open pipeline so the queue's all-time total is
    # meaningfully larger than the open-only figure the Network Flow card shows,
    # and the status filter has real data across every state. Open states sit in
    # STO_OPEN_STATUSES; anything else is terminal and excluded from flow counts.
    _STO_SEED_MIX = (
        ("requested", 3),
        ("picking", 3),
        ("in_transit", 5),
        ("delivered", 6),
        ("cancelled", 2),
    )

    def _gen_transfer_orders(self, now: datetime) -> list:
        """Seed hub-raised STOs on the NDC across the full lifecycle — an open
        pipeline (requested → picking → in_transit) plus terminal orders
        (delivered with a goods receipt, and a few cancelled) — so the queue and
        the Network Flow summary tell a consistent story."""
        skus = [
            ("SKU-BLR-001", "Diverter Valve - Vaillant ecoTEC"),
            ("SKU-BLR-005", "Pressure Relief Valve 3 bar"),
            ("SKU-SM-001", "SMET2 Dual Fuel Meter Kit BG"),
            ("SKU-BLR-002", "Heat Exchanger - Navien NCB-E"),
            ("SKU-EV-001", "Alfen Eve Pro 22kW Charger"),
            ("SKU-BLR-003", "Fan Motor Assembly"),
            ("SKU-BLR-004", "Ignition Electrode & Lead"),
            ("SKU-SM-002", "SMET2 Electricity Meter Kit"),
            ("SKU-EV-002", "Type 2 Tethered Cable 5m"),
        ]
        # A flat list of statuses to assign, one per STO, per the target mix.
        status_plan = [st for st, n in self._STO_SEED_MIX for _ in range(n)]
        random.shuffle(status_plan)

        transfers = []
        for i, status in enumerate(status_plan):
            sku, desc = skus[i % len(skus)]
            hub = random.choice(HUB_CODES)
            lead = HUB_TRANSFER_LEAD_DAYS.get(hub, 2)
            hub_name = next(w["name"] for w in WAREHOUSES_DATA if w["code"] == hub)
            self._transfer_counter += 1
            # Terminal orders were raised further back so their timeline reads
            # sensibly; open orders are recent and still in flight.
            age_hours = rnd(28, 96) if status in ("delivered", "cancelled") else rnd(4, 30)
            requested = now - timedelta(hours=age_hours)
            eta = requested + timedelta(days=lead)
            t = {
                "transfer_id": f"STO-{2026100 + self._transfer_counter}",
                "sku_code": sku,
                "description": desc,
                # The requesting hub owns the document; the NDC supplies it
                "raised_by": hub,
                "raised_by_name": hub_name,
                "supplying_site": NDC_CODE,
                "supplying_site_name": "Leicester NDC",
                "doc_type": "UB",
                "delivery_type": "NL",
                "is_lateral": False,
                "transfer_lead_days": lead,
                "from_warehouse": NDC_CODE,
                "from_warehouse_name": "Leicester NDC",
                "to_warehouse": hub,
                "to_warehouse_name": hub_name,
                "quantity": random.randint(2, 12) * 5,
                "status": status,
                "is_auto_generated": random.random() < 0.5,
                "reason": f"{hub_name} raised an STO on the Leicester NDC — scheduled DRP replenishment",
                "requested_at": requested.isoformat(),
                "expected_arrival": eta.isoformat(),
                "created_at": requested.isoformat()}
            # Backfill the intermediate lifecycle timestamps so a downstream
            # status is internally consistent with the steps it passed through.
            if status in ("picking", "in_transit", "delivered"):
                t["confirmed_at"] = (requested + timedelta(hours=rnd(1, 4))).isoformat()
            if status in ("in_transit", "delivered"):
                t["goods_issue_at"] = (requested + timedelta(hours=rnd(5, 10))).isoformat()
            if status == "delivered":
                received = eta - timedelta(hours=rnd(0, 6))
                t.update({
                    "received_at": received.isoformat(),
                    "goods_receipt_at": received.isoformat(),
                    "goods_receipt_note": f"GRN-{t['transfer_id'].split('-')[-1]}"})
            if status == "cancelled":
                t["cancelled_at"] = (requested + timedelta(hours=rnd(2, 12))).isoformat()
                t["reason"] = f"{hub_name} cancelled the STO — demand covered by a lateral rebalance"
            transfers.append(t)
        return transfers

    # Statuses an STO passes through, mirroring the SAP intra-company flow:
    # the RECEIVING plant raises the order, the SUPPLYING plant picks and issues
    # the goods, and the receiving plant posts the goods receipt.
    STO_OPEN_STATUSES = ("requested", "picking", "in_transit")

    def _build_sto(self, sku_code: str, requesting_site: str, supplying_site: str,
                   quantity: int, reason: str, auto: bool) -> dict:
        """Create a Stock Transport Order. In this network a hub is always the
        REQUESTING (receiving) plant and the NDC — or, on a lateral rebalance, a
        sister hub — is the SUPPLYING plant. Goods flow supplying → requesting;
        the paperwork is raised by the site that needs the stock."""
        now = datetime.now(timezone.utc)
        lead = HUB_TRANSFER_LEAD_DAYS.get(requesting_site, 2) if supplying_site == NDC_CODE else 1
        self._transfer_counter += 1
        item = next((i for i in self._snapshot.get("inventory_positions", []) if i["sku_code"] == sku_code), None)
        name = lambda code: next((w["name"] for w in WAREHOUSES_DATA if w["code"] == code), code)
        return {
            "transfer_id": f"STO-{2026100 + self._transfer_counter}",
            "sku_code": sku_code,
            "description": (item or {}).get("description", sku_code),
            # ── who raised it (receiving plant) vs who fulfils it (supplying plant)
            "raised_by": requesting_site,
            "raised_by_name": name(requesting_site),
            "supplying_site": supplying_site,
            "supplying_site_name": name(supplying_site),
            "doc_type": "UB",                     # SAP intra-company STO
            "delivery_type": "NL",                # replenishment delivery, no billing
            # ── goods movement direction (supplying → requesting)
            "from_warehouse": supplying_site,
            "from_warehouse_name": name(supplying_site),
            "to_warehouse": requesting_site,
            "to_warehouse_name": name(requesting_site),
            "is_lateral": supplying_site != NDC_CODE,
            "quantity": quantity,
            "status": "requested",
            "is_auto_generated": auto,
            "reason": reason,
            "requested_at": now.isoformat(),
            "expected_arrival": (now + timedelta(days=lead)).isoformat(),
            "transfer_lead_days": lead,
            "created_at": now.isoformat()}

    def create_transfer_order(self, data: dict) -> dict:
        """Raise an STO. `to_warehouse` is the requesting (receiving) hub;
        `from_warehouse` is the supplying site, defaulting to the Leicester NDC."""
        requesting = data.get("to_warehouse", "COV_HUB")
        supplying = data.get("from_warehouse") or NDC_CODE
        sto = self._build_sto(
            data.get("sku_code"), requesting, supplying, data.get("quantity") or 0,
            data.get("notes") or f"{requesting} raised an STO on {supplying} for hub replenishment",
            auto=False,
        )
        self._snapshot.setdefault("transfer_orders", []).insert(0, sto)
        return sto

    def auto_rebalance_hub_transfers(self) -> list:
        """DRP auto-replenishment for the hub echelon. A hub that goes critical
        raises an STO on the Leicester NDC (the hub is the receiving plant, so the
        hub owns the request); the NDC supplies it if it has cover above its own
        safety stock. Skips (SKU, hub) pairs that already have an STO in flight."""
        s = self._snapshot
        open_pairs = {
            (t.get("sku_code"), t.get("to_warehouse"))
            for t in s.get("transfer_orders", [])
            if t.get("status") in self.STO_OPEN_STATUSES
        }
        raised = []
        _now = datetime.now(timezone.utc)
        for item in s.get("inventory_positions", []):
            sites = {w["warehouse_code"]: w for w in item.get("by_warehouse", [])}
            ndc = sites.get(NDC_CODE)
            if not ndc:
                continue
            if len(raised) >= self._AUTO_TRANSFER_MAX_PER_TICK:
                break
            for code in HUB_CODES:
                hub = sites.get(code)
                if not hub or hub["rag_status"] != "R" or (item["sku_code"], code) in open_pairs:
                    continue
                need = hub.get("replenishment_qty") or 0
                ndc_headroom = max(0, ndc["quantity_available"] - ndc["safety_stock_level"])
                supplying, qty = NDC_CODE, min(need, ndc_headroom)
                if qty <= 0 and need > 0:
                    # NDC cannot cover — look sideways for a sister hub with surplus
                    donor = next((sites[h] for h in HUB_CODES if h != code
                                  and sites.get(h, {}).get("rag_status") == "G"
                                  and (sites[h]["quantity_available"] - sites[h]["safety_stock_level"]) >= need), None)
                    if donor:
                        supplying, qty = donor["warehouse_code"], need
                if qty <= 0:
                    continue
                lead = HUB_TRANSFER_LEAD_DAYS.get(code, 2) if supplying == NDC_CODE else 1
                self._transfer_counter += 1
                transfer = {
                    "transfer_id": f"STO-{2026100 + self._transfer_counter}",
                    "sku_code": item["sku_code"],
                    "description": item["description"],
                    "raised_by": code,
                    "raised_by_name": hub["warehouse_name"],
                    "supplying_site": supplying,
                    "supplying_site_name": next((w["name"] for w in WAREHOUSES_DATA if w["code"] == supplying), supplying),
                    "doc_type": "UB",
                    "delivery_type": "NL",
                    "is_lateral": supplying != NDC_CODE,
                    "transfer_lead_days": lead,
                    "from_warehouse": supplying,
                    "from_warehouse_name": next((w["name"] for w in WAREHOUSES_DATA if w["code"] == supplying), supplying),
                    "to_warehouse": code,
                    "to_warehouse_name": hub["warehouse_name"],
                    "quantity": qty,
                    "status": "requested",
                    "is_auto_generated": True,
                    "reason": (
                        f"AUTO DRP: {hub['warehouse_name']} raised an STO on "
                        f"{'the Leicester NDC' if supplying == NDC_CODE else 'sister hub ' + str(supplying)} — "
                        f"{hub['days_of_supply']}d cover vs {lead}d transfer lead, {qty} units supplied"
                    ),
                    "requested_at": _now.isoformat(),
                    "expected_arrival": (_now + timedelta(days=lead)).isoformat(),
                    "created_at": _now.isoformat()}
                s.setdefault("transfer_orders", []).insert(0, transfer)
                raised.append(transfer)
        if raised:
            s["auto_transfer_log"] = (raised + s.get("auto_transfer_log", []))[:25]
        return raised

    # ─────────────────────────────────────────────
    # INTELLIGENT REPLENISHMENT ENGINE (DRP) — feeds the Planner Worklist
    # ─────────────────────────────────────────────

    def _drp_recommendations(self, category: str | None = None, segment: str | None = None) -> list[dict]:
        """Time-phased DRP recommendations across the two-echelon network:
        expedite/raise supplier POs into the NDC, trunker transfers NDC → hubs,
        and hub → NDC rebalances when the NDC is starved but a hub has surplus.
        Feeds the Planner Worklist with the concrete network move that resolves
        each shortage, rather than a generic "raise a PO" line."""
        s = self._snapshot
        recs = []
        # Map each SKU to a specific in-flight PO so an "expedite" action can target
        # that real order rather than raising a new one. Prefer a non-emergency PO
        # (expediting it actually pulls the ETA in), else keep the first seen.
        open_po_by_sku: dict = {}
        for p in s.get("purchase_orders", []):
            if p.get("sku_code") and p.get("status") in ("draft", "confirmed", "in_transit"):
                cur = open_po_by_sku.get(p["sku_code"])
                if cur is None or (cur.get("po_type") == "emergency" and p.get("po_type") != "emergency"):
                    open_po_by_sku[p["sku_code"]] = p
        open_po_skus = set(open_po_by_sku.keys())
        open_transfer_pairs = {
            (t.get("sku_code"), t.get("to_warehouse"))
            for t in s.get("transfer_orders", [])
            if t.get("status") in self.STO_OPEN_STATUSES
        }
        for item in self._filter_inventory(None, category, segment, None, None):
            sku = item["sku_code"]
            sites = {w["warehouse_code"]: w for w in item.get("by_warehouse", [])}
            ndc = sites.get(NDC_CODE)
            supplier_code = self._SKU_SUPPLIER.get(sku, "WOL_UK")
            supplier_name = next((sp["name"] for sp in SUPPLIER_DATA if sp["supplier_code"] == supplier_code), supplier_code)

            # ── NDC / network echelon: supplier-facing actions
            if ndc and ndc["rag_status"] != "G":
                if sku in open_po_skus and ndc["rag_status"] == "R":
                    inflight = open_po_by_sku[sku]
                    po_no = inflight.get("po_number")
                    recs.append({
                        "rec_id": f"REC-EXP-{sku}",
                        "type": "expedite",
                        "priority": 1,
                        "sku_code": sku, "description": item["description"], "segment": item.get("segment"),
                        "po_number": po_no,
                        "from_name": supplier_name, "to_code": NDC_CODE, "to_name": "Leicester NDC",
                        "quantity": inflight.get("quantity") or item.get("target_order_qty") or ndc.get("replenishment_qty") or 0,
                        "reason": (
                            f"NDC critical at {ndc['days_of_supply']}d cover vs {ndc['replenishment_lead_days']}d supplier lead — "
                            f"PO {po_no} is already in flight; expedite it via {supplier_name} rather than raise a new order"
                        ),
                        "eta_days": 2},)
                elif sku not in open_po_skus:
                    qty = item.get("target_order_qty") or ndc.get("replenishment_qty") or 0
                    if qty > 0:
                        recs.append({
                            "rec_id": f"REC-PO-{sku}",
                            "type": "purchase",
                            "priority": 1 if ndc["rag_status"] == "R" else 2,
                            "sku_code": sku, "description": item["description"], "segment": item.get("segment"),
                            "from_name": supplier_name, "from_code": supplier_code,
                            "to_code": NDC_CODE, "to_name": "Leicester NDC",
                            "quantity": qty,
                            "reason": (
                                f"NDC at {ndc['days_of_supply']}d cover ({'critical' if ndc['rag_status'] == 'R' else 'below reorder window'}); "
                                f"order-up-to target needs {qty} units from {supplier_name} "
                                f"({ndc['replenishment_lead_days']}d lead)"
                            ),
                            "eta_days": ndc["replenishment_lead_days"]},)

            # ── Hub echelon: transfer / rebalance actions
            for code in HUB_CODES:
                hub = sites.get(code)
                if not hub:
                    continue
                if hub["rag_status"] != "G" and (sku, code) not in open_transfer_pairs:
                    qty = hub.get("replenishment_qty") or 0
                    ndc_headroom = max(0, (ndc["quantity_available"] - ndc["safety_stock_level"])) if ndc else 0
                    if qty > 0 and ndc_headroom > 0:
                        send = min(qty, ndc_headroom)
                        recs.append({
                            "rec_id": f"REC-TRF-{sku}-{code}",
                            "type": "transfer",
                            "priority": 1 if hub["rag_status"] == "R" else 2,
                            "sku_code": sku, "description": item["description"], "segment": item.get("segment"),
                            "from_code": NDC_CODE, "from_name": "Leicester NDC",
                            "to_code": code, "to_name": hub["warehouse_name"],
                            "raised_by": code, "doc_type": "UB",
                            "quantity": send,
                            "reason": (
                                f"{hub['warehouse_name']} raises an STO on the Leicester NDC — "
                                f"{hub['days_of_supply']}d cover vs {hub['replenishment_lead_days']}d trunker lead; "
                                f"NDC has {ndc_headroom} units above its own safety stock"
                            ),
                            "eta_days": hub["replenishment_lead_days"]},)
                    elif qty > 0:
                        # NDC can't cover the hub — check sister hubs for surplus
                        donor = next((sites[h] for h in HUB_CODES if h != code
                                      and sites.get(h, {}).get("rag_status") == "G"
                                      and (sites[h]["quantity_available"] - sites[h]["safety_stock_level"]) >= qty), None)
                        if donor:
                            recs.append({
                                "rec_id": f"REC-RBL-{sku}-{code}",
                                "type": "rebalance",
                                "priority": 1 if hub["rag_status"] == "R" else 2,
                                "sku_code": sku, "description": item["description"], "segment": item.get("segment"),
                                "from_code": donor["warehouse_code"], "from_name": donor["warehouse_name"],
                                "to_code": code, "to_name": hub["warehouse_name"],
                                "quantity": qty,
                                "reason": (
                                    f"NDC buffer exhausted; {donor['warehouse_name']} holds "
                                    f"{donor['quantity_available'] - donor['safety_stock_level']} units above safety — "
                                    f"lateral rebalance to {hub['warehouse_name']}"
                                ),
                                "eta_days": 1},)
        # Cost-to-serve on every action: the order's working capital, the annual
        # cost to carry it, the stockout penalty it avoids, and any expedite
        # premium — netted so the planner ranks by £ benefit, not just cover days.
        cost_by_sku = {i["sku_code"]: i.get("unit_cost_gbp", 50) for i in s.get("inventory_positions", [])}
        for r in recs:
            qty = r.get("quantity") or 0
            unit = cost_by_sku.get(r["sku_code"], 50)
            order_value = round(qty * unit)
            holding = round(order_value * HOLDING_COST_RATE_PA * (r.get("eta_days", 3) / 365.0), 2)
            # A priority-1 (critical) action averts a stockout on roughly the buffer it restores
            stockout_avoided = round(qty * unit * STOCKOUT_PENALTY_RATE) if r["priority"] == 1 else 0
            expedite_premium = round(order_value * EXPEDITE_PREMIUM_RATE) if r["type"] == "expedite" else 0
            r["impact_gbp"] = order_value
            r["order_value_gbp"] = order_value
            r["holding_cost_gbp"] = holding
            r["stockout_avoided_gbp"] = stockout_avoided
            r["expedite_premium_gbp"] = expedite_premium
            r["net_benefit_gbp"] = round(stockout_avoided - expedite_premium - holding)
        return recs

    def get_demand_network(self) -> dict:
        """Network flow summary: suppliers → NDC → hubs, with per-site stock
        health and in-flight replenishment volumes on each leg."""
        s = self._snapshot
        inventory = s.get("inventory_positions", [])
        pos = [p for p in s.get("purchase_orders", []) if p.get("status") in ("draft", "confirmed", "in_transit")]
        # "requested" is the first stage of an STO's life (raised, not yet
        # confirmed/picked by the supplying site) — STO_OPEN_STATUSES is the
        # canonical "still open" definition used everywhere else; using a
        # narrower tuple here undercounted (down to 0) whenever every open STO
        # happened to still be in "requested".
        transfers = [t for t in s.get("transfer_orders", []) if t.get("status") in self.STO_OPEN_STATUSES]
        wh_status = {w["code"]: w for w in s.get("warehouse_status", [])}

        def site_summary(code: str) -> dict:
            entries = [w for i in inventory for w in i.get("by_warehouse", []) if w["warehouse_code"] == code]
            finite_dos = [e["days_of_supply"] for e in entries if e["days_of_supply"] < 900]
            wh = wh_status.get(code, {})
            meta = next((w for w in WAREHOUSES_DATA if w["code"] == code), {})
            return {
                "warehouse_code": code,
                "warehouse_name": meta.get("name", code),
                "role": "ndc" if code == NDC_CODE else "hub",
                "units_on_hand": sum(e["quantity_on_hand"] for e in entries),
                "skus_at_risk": len([e for e in entries if e["rag_status"] != "G"]),
                "stockouts": len([e for e in entries if e["quantity_on_hand"] == 0]),
                "avg_days_of_supply": round(sum(finite_dos) / len(finite_dos), 1) if finite_dos else 0,
                "throughput_vs_baseline_pct": wh.get("throughput_vs_baseline_pct"),
                "is_disrupted": wh.get("is_disrupted", False),
                "transfer_lead_days": HUB_TRANSFER_LEAD_DAYS.get(code)}

        supplier_scorecards = s.get("supplier_scorecards", [])
        otifs = [sp.get("otif_score") for sp in supplier_scorecards if sp.get("otif_score") is not None]

        # One directed edge per (supplying site → raised-by site) pair with an
        # open STO on it — an NDC→hub trunk normally, but a hub→hub lateral
        # rebalance when the NDC can't cover a shortfall and a sister hub can.
        route_map: dict = {}
        for t in transfers:
            from_code, to_code = t.get("from_warehouse"), t.get("to_warehouse")
            if not from_code or not to_code:
                continue
            r = route_map.setdefault((from_code, to_code), {
                "from_code": from_code, "to_code": to_code,
                "lateral": from_code != NDC_CODE, "count": 0, "units": 0})
            r["count"] += 1
            r["units"] += t.get("quantity") or 0
        routes = sorted(route_map.values(), key=lambda r: (-r["count"], -r["units"]))

        return {
            "suppliers": {
                "count": len(SUPPLIER_DATA),
                "avg_otif": round(sum(otifs) / len(otifs), 1) if otifs else None,
                "open_pos": len(pos),
                "open_po_value_gbp": round(sum(p.get("total_value_gbp") or 0 for p in pos), 2)},
            "ndc": site_summary(NDC_CODE),
            "hubs": [
                {
                    **site_summary(code),
                    "inbound_transfers": len([t for t in transfers if t["to_warehouse"] == code]),
                    "inbound_transfer_units": sum(t.get("quantity") or 0 for t in transfers if t["to_warehouse"] == code),
                }
                for code in HUB_CODES
            ],
            "flows": {
                "supplier_to_ndc": {"open_pos": len(pos), "emergency_pos": len([p for p in pos if p.get("po_type") == "emergency"])},
                "ndc_to_hubs": {"open_transfers": len(transfers), "units_in_transit": sum(t.get("quantity") or 0 for t in transfers)}},
            "routes": routes}

    # ─────────────────────────────────────────────
    # CAUSAL ENGINE — Sense · Position · Orchestrate · Learn
    # ─────────────────────────────────────────────

    def _sku_desc(self, sku_code: str) -> str:
        item = next((i for i in self._snapshot.get("inventory_positions", []) if i["sku_code"] == sku_code), None)
        return item["description"] if item else sku_code

    # ── Server-side query model (scales the page to 1000+ SKUs) ──────────────
    # Every list is paged/filtered/sorted here and every aggregate is computed
    # here, so the client never has to hold the full catalogue to be correct.

    _RAG_ORDER = {"R": 0, "A": 1, "G": 2}
    # Heavy nested fields stripped from list responses — fetched per SKU on drill-in
    _LIST_OMIT = ("by_warehouse", "forecast_quality", "demand_drivers")

    def _scope_item(self, item: dict, warehouse_code: str | None) -> dict | None:
        """Project a network position onto one site, keeping field names identical
        so filtering, sorting and the table work the same at any scope."""
        if not warehouse_code or warehouse_code == "NETWORK":
            return item
        site = next((w for w in item.get("by_warehouse", []) if w["warehouse_code"] == warehouse_code), None)
        if not site:
            return None
        lead = site.get("replenishment_lead_days", 2)
        review = site.get("review_period_days", 2)
        daily = site.get("daily_consumption", 0)
        unit = item.get("unit_cost_gbp", 50)
        max_stock = site["safety_stock_level"] + round((lead + review) * daily)
        available = site["quantity_available"]
        excess_units = max(0, available - max_stock)
        is_excess = site["rag_status"] == "G" and available > round(max_stock * 1.25)
        return {
            **item,
            "warehouse_code": warehouse_code,
            "quantity_on_hand": site["quantity_on_hand"],
            "quantity_reserved": site["quantity_reserved"],
            "quantity_available": available,
            "safety_stock_level": site["safety_stock_level"],
            "days_of_supply": site["days_of_supply"],
            "lead_time_days": lead,
            "review_period_days": review,
            "reorder_point": max_stock,
            "daily_consumption_adjusted": daily,
            "target_order_qty": site.get("replenishment_qty", 0),
            "rag_status": site["rag_status"],
            "stock_value_gbp": round(site["quantity_on_hand"] * unit),
            "excess_units": excess_units if is_excess else 0,
            "excess_value_gbp": round(excess_units * unit) if is_excess else 0,
            "is_excess": is_excess}

    def _filter_inventory(self, search=None, category=None, segment=None, rag=None,
                          warehouse_code=None, excess_only=False) -> list:
        needle = (search or "").strip().lower()
        out = []
        for it in self._snapshot.get("inventory_positions", []):
            if category and category != "all" and it.get("category") != category:
                continue
            if segment and segment != "all" and it.get("segment") != segment:
                continue
            if needle and needle not in it["sku_code"].lower() and needle not in it.get("description", "").lower():
                continue
            scoped = self._scope_item(it, warehouse_code)
            if scoped is None:
                continue
            if rag and rag != "all" and scoped.get("rag_status") != rag:
                continue
            if excess_only and not scoped.get("is_excess"):
                continue
            out.append(scoped)
        return out

    def query_inventory(self, page: int = 1, per_page: int = 25, search: str | None = None,
                        category: str | None = None, segment: str | None = None,
                        rag: str | None = None, warehouse_code: str | None = None,
                        sort: str = "risk", include_sites: bool = False) -> dict:
        """Paged, searchable, sortable slice of the catalogue."""
        rows = self._filter_inventory(search, category, segment, rag, warehouse_code)
        desc = sort.startswith("-")
        key = sort.lstrip("-")
        if key == "risk":
            rows.sort(key=lambda i: (self._RAG_ORDER.get(i.get("rag_status"), 3), i.get("days_of_supply") or 0))
        elif key in ("sku_code", "description", "segment", "category"):
            rows.sort(key=lambda i: str(i.get(key) or ""), reverse=desc)
        else:
            rows.sort(key=lambda i: i.get(key) or 0, reverse=desc)
        total = len(rows)
        per_page = max(1, min(200, per_page))
        pages = max(1, (total + per_page - 1) // per_page)
        page = max(1, min(page, pages))
        start = (page - 1) * per_page
        sliced = rows[start:start + per_page]
        if not include_sites:
            sliced = [{k: v for k, v in r.items() if k not in self._LIST_OMIT} for r in sliced]
        return {"items": sliced, "total": total, "page": page, "per_page": per_page, "pages": pages,
                "catalogue_size": len(self._snapshot.get("inventory_positions", []))}

    def get_inventory_item(self, sku_code: str, warehouse_code: str | None = None) -> dict:
        """Full position for one SKU — sites, forecast quality and demand drivers."""
        item = next((i for i in self._snapshot.get("inventory_positions", []) if i["sku_code"] == sku_code), None)
        if not item:
            return {}
        scoped = self._scope_item(item, warehouse_code) or item
        return {**scoped, "by_warehouse": item.get("by_warehouse", []),
                "forecast_quality": item.get("forecast_quality"),
                "demand_drivers": item.get("demand_drivers", [])}

    def _demand_sensing_summary(self, rows: list) -> dict:
        """Compact demand-sensing state for dashboards outside this module: what
        each signal is doing, in plain terms, plus how much of the catalogue it
        has moved. Sourced from the same driver scores the forecast uses."""
        signals = self._snapshot.get("demand_signals", {})
        scores = _driver_scores(signals)
        w = signals.get("weather", {})
        hdd_score = scores.get("heating_degree_days", 0.0)
        iot_score = scores.get("hive_faults", 0.0)
        cond = ("Colder than seasonal norm" if hdd_score > 0.005
                else "Milder than seasonal norm" if hdd_score < -0.005
                else "In line with seasonal norm")
        return {
            "weather_condition": cond,
            "weather_delta_pct": round(hdd_score * 100, 1),
            "iot_delta_pct": round(iot_score * 100, 1),
            "frozen_condensate_risk": bool(w.get("frozen_condensate_risk")),
            "heating_degree_days_7d": w.get("heating_degree_days_7d"),
            "region": w.get("region"),
            "skus_elevated": sum(1 for i in rows if (i.get("demand_uplift_applied") or 1) > 1.005),
            "skus_suppressed": sum(1 for i in rows if (i.get("demand_uplift_applied") or 1) < 0.995)}

    # What each ABC/XYZ cell MEANS commercially. A is high annual value, C low;
    # X is predictable demand, Z erratic. The combination dictates how much service
    # to buy, how often to review, and where a planner's attention actually pays.
    _SEGMENT_IMPLICATIONS = {
        "AX": {"label": "Cash cows — protect", "policy": "Tight control, high service",
               "review": "Weekly", "buffer": "Lean — demand is predictable",
               "action": "Automate replenishment; any stockout here is expensive and avoidable.",
               "risk": "low"},
        "AY": {"label": "High value, variable", "policy": "High service, watch closely",
               "review": "Weekly", "buffer": "Moderate",
               "action": "Keep forecast bias near zero — the buffer is costly, so accuracy pays.",
               "risk": "medium"},
        "AZ": {"label": "The hard ones — plan manually", "policy": "Highest £ risk per SKU",
               "review": "Twice weekly", "buffer": "Largest — volatility plus value",
               "action": "Planner attention first. Consider dual-sourcing or supplier collaboration.",
               "risk": "high"},
        "BX": {"label": "Steady mid-value", "policy": "Standard service",
               "review": "Fortnightly", "buffer": "Lean",
               "action": "Safe to automate; review only on exception.", "risk": "low"},
        "BY": {"label": "Routine planning", "policy": "Standard service",
               "review": "Fortnightly", "buffer": "Moderate",
               "action": "Rule-driven replenishment with periodic policy review.", "risk": "medium"},
        "BZ": {"label": "Volatile mid-value", "policy": "Accept lower service",
               "review": "Weekly", "buffer": "Higher — volatility drives it",
               "action": "Buffer rather than forecast; chasing accuracy here rarely pays.", "risk": "medium"},
        "CX": {"label": "Cheap and predictable", "policy": "Low touch",
               "review": "Monthly", "buffer": "Generous — carrying cost is trivial",
               "action": "Over-stock deliberately. Cheaper than the effort of managing it.", "risk": "low"},
        "CY": {"label": "Low value, some variability", "policy": "Low touch",
               "review": "Monthly", "buffer": "Generous",
               "action": "Bulk order to cut transaction cost; don't spend planner time here.", "risk": "low"},
        "CZ": {"label": "Erratic long tail — candidates to cull", "policy": "Lowest service target",
               "review": "Quarterly", "buffer": "Min-max or make-to-order",
               "action": "Review for rationalisation; these clog the catalogue and age into write-off.",
               "risk": "medium"},
    }

    def get_inventory_summary(self, search: str | None = None, category: str | None = None,
                              segment: str | None = None, warehouse_code: str | None = None) -> dict:
        """Every aggregate the page needs, computed over the FULL filtered catalogue
        — so KPIs, the segment matrix and health stay correct no matter which page
        of rows the client happens to be showing."""
        rows = self._filter_inventory(search, category, segment, None, warehouse_code)
        n = len(rows)
        finite = [r.get("days_of_supply") or 0 for r in rows if (r.get("days_of_supply") or 0) < 900]
        stock_value = sum(r.get("stock_value_gbp", 0) for r in rows)

        seg, cats = {}, {}
        for r in rows:
            s = r.get("segment") or "—"
            e = seg.setdefault(s, {"segment": s, "count": 0, "value_gbp": 0, "at_risk": 0,
                                   "excess_gbp": 0, "service_level_target_pct": r.get("service_level_target_pct"),
                                   **(self._SEGMENT_IMPLICATIONS.get(s, {}))})
            e["count"] += 1
            e["value_gbp"] += r.get("stock_value_gbp", 0)
            e["excess_gbp"] += r.get("excess_value_gbp", 0)
            if r.get("rag_status") != "G":
                e["at_risk"] += 1
            ck = r.get("category") or "other"
            ce = cats.setdefault(ck, {"category": ck, "count": 0, "at_risk": 0})
            ce["count"] += 1
            if r.get("rag_status") != "G":
                ce["at_risk"] += 1

        totw = stock_value or 1
        wmape = sum(((r.get("forecast_quality") or {}).get("mape_pct", 0)) * r.get("stock_value_gbp", 0) for r in rows) / totw
        mean_bias = (sum((r.get("forecast_quality") or {}).get("bias_pct", 0) for r in rows) / n) if n else 0

        all_items = self._snapshot.get("inventory_positions", [])
        sites = []
        for code in [NDC_CODE] + HUB_CODES:
            entries = [w for i in all_items for w in i.get("by_warehouse", []) if w["warehouse_code"] == code]
            sites.append({"warehouse_code": code,
                          "at_risk": sum(1 for e in entries if e["rag_status"] != "G"),
                          "stockouts": sum(1 for e in entries if e["quantity_on_hand"] == 0)})

        crit = sum(1 for r in rows if r.get("rag_status") == "R")
        low = sum(1 for r in rows if r.get("rag_status") == "A")
        excess_n = sum(1 for r in rows if r.get("is_excess"))
        return {
            "count": n,
            "catalogue_size": len(all_items),
            "at_risk": crit + low,
            "critical": crit,
            "low": low,
            "healthy": n - crit - low - excess_n,
            "excess": excess_n,
            "stockouts": sum(1 for r in rows if r.get("quantity_available") == 0),
            "avg_days_of_supply": round(sum(finite) / len(finite), 1) if finite else 0,
            "fill_rate_pct": round(sum(1 for r in rows if (r.get("quantity_available") or 0) >= (r.get("safety_stock_level") or 0)) / n * 100, 1) if n else 100.0,
            "stock_value_gbp": round(stock_value),
            "excess_value_gbp": round(sum(r.get("excess_value_gbp", 0) for r in rows)),
            "value_at_risk_gbp": round(sum((r.get("target_order_qty") or 0) * r.get("unit_cost_gbp", 50) for r in rows if r.get("rag_status") == "R")),
            "wmape_pct": round(wmape, 1),
            "mean_bias_pct": round(mean_bias, 1),
            # Real demand-sensing state, so dependent dashboards can show what is
            # actually moving demand instead of the old uniform uplift scalar
            # (which no longer feeds the model and would read as a live driver).
            "demand_sensing": self._demand_sensing_summary(rows),
            "segments": sorted(seg.values(), key=lambda x: x["segment"]),
            "categories": sorted(cats.values(), key=lambda x: -x["count"]),
            "sites": sites}

    def get_dependent_demand(self, horizon_days: int = 30) -> dict:
        """SENSE · explode the install / CPQ pipeline through bills-of-material into
        component-level dependent demand. In a home-services business parts demand
        IS installs — this is what connects the two."""
        s = self._snapshot
        signals = s.get("demand_signals", {})
        weeks = max(1.0, horizon_days / 7.0)
        lines, by_sku = [], {}
        for job_key, bom in INSTALL_BOM.items():
            weekly = _signal_value(signals, bom["weekly_rate_path"]) if bom.get("weekly_rate_path") else None
            jobs = round(weekly * weeks) if weekly else round((_signal_value(signals, bom["pipeline_path"]) or 0) * bom.get("horizon_share", 0.5))
            comps = []
            for c in bom["components"]:
                units = round(jobs * c["attach"])
                cost = SKU_CONFIG.get(c["sku_code"], {}).get("unit_cost_gbp", 50)
                comps.append({"sku_code": c["sku_code"], "description": self._sku_desc(c["sku_code"]),
                              "attach_rate": c["attach"], "units": units, "value_gbp": round(units * cost)})
                agg = by_sku.setdefault(c["sku_code"], {"sku_code": c["sku_code"], "description": self._sku_desc(c["sku_code"]),
                                                        "dependent_units": 0, "value_gbp": 0})
                agg["dependent_units"] += units
                agg["value_gbp"] += round(units * cost)
            lines.append({"job_type": job_key, "label": bom["label"], "jobs_in_horizon": jobs,
                          "components": comps, "value_gbp": sum(c["value_gbp"] for c in comps)})
        for sku, agg in by_sku.items():
            item = next((i for i in s.get("inventory_positions", []) if i["sku_code"] == sku), None)
            avail = item.get("quantity_available", 0) if item else 0
            agg["available"] = avail
            agg["coverage_pct"] = round(min(999, avail / agg["dependent_units"] * 100)) if agg["dependent_units"] else None
        return {
            "horizon_days": horizon_days,
            "job_lines": lines,
            "by_sku": sorted(by_sku.values(), key=lambda x: -x["value_gbp"]),
            "total_value_gbp": sum(l["value_gbp"] for l in lines),
            "engine": "BOM explosion · CPQ/install pipeline → dependent part demand"}

    def get_meio(self, page: int = 1, per_page: int = 10, segment: str | None = None,
                 category: str | None = None) -> dict:
        """POSITION · multi-echelon inventory optimisation.

        MEIO is exactly the right lens for this topology — a central DC feeding
        hubs that replenish ONLY from it. The meaningful comparison is not "what if
        hubs bought direct" (they never can); it is how the buffer is SIZED:

          · Single-echelon — every location is sized independently against total
            demand-during-lead, blind to stock already sitting downstream. This is
            what most planning systems do by default, and it double-counts the
            buffer at both levels.
          · Multi-echelon (echelon stock) — a location's buffer accounts for the
            inventory it supplies downstream. Hubs cover only the 1–2 day trunker
            lead; the NDC pools the aggregate variability against the long supplier
            lead. Pooling n hubs cuts the buffer roughly by √n.

        The gap between the two is duplicated safety stock — real working capital."""
        rows, echelon_total, single_total = [], 0.0, 0.0
        for item in self._filter_inventory(None, category, segment, None, None):
            sku = item["sku_code"]
            pol = PLANNING_POLICY.get(sku, {})
            z, cv = pol.get("z", 1.65), pol.get("demand_cv", 0.4)
            unit = pol.get("unit_cost_gbp", 50)
            supplier_lead, review = item["lead_time_days"], item["review_period_days"]
            supplier_cv = pol.get("lead_time_cv", 0.1)
            echelon_sku = single_sku = 0.0
            for w in item.get("by_warehouse", []):
                daily = w["daily_consumption"]
                # In force: echelon sizing — each site buffers its OWN replenishment lead
                echelon_sku += w["safety_stock_level"]
                # Counterfactual: single-echelon — every site independently buffers the
                # full supplier lead, ignoring the stock held upstream on its behalf
                sd, sl = cv * daily, supplier_lead * supplier_cv
                single_sku += z * math.sqrt((supplier_lead + review) * sd ** 2 + daily ** 2 * sl ** 2)
            echelon_total += echelon_sku * unit
            single_total += single_sku * unit
            rows.append({"sku_code": sku, "description": item["description"], "segment": item.get("segment"),
                         "echelon_units": round(echelon_sku), "single_echelon_units": round(single_sku),
                         # kept under the old names so existing clients keep working
                         "pooled_units": round(echelon_sku), "decentralised_units": round(single_sku),
                         "saving_units": round(single_sku - echelon_sku),
                         "saving_gbp": round((single_sku - echelon_sku) * unit)})
        rows.sort(key=lambda r: -r["saving_gbp"])
        env = self._page(rows, page, per_page)
        return {
            "engine": "Multi-echelon inventory optimisation · echelon stock vs single-echelon sizing",
            **env,
            "rows": env["items"],
            "row_count": env["total"],
            "echelon_capital_gbp": round(echelon_total),
            "single_echelon_capital_gbp": round(single_total),
            "pooled_capital_gbp": round(echelon_total),
            "decentralised_capital_gbp": round(single_total),
            "capital_released_gbp": round(single_total - echelon_total),
            "pooling_benefit_pct": round((1 - echelon_total / single_total) * 100, 1) if single_total else 0,
            "why_relevant": (
                "Hubs replenish only from the NDC, so the question is never where to buy — it is how much buffer "
                "each echelon carries. Sizing every site independently duplicates the buffer at both levels; "
                "echelon sizing lets hubs run lean behind a 1–2 day trunker while the NDC pools the variability."
            )}

    def _excess_rows(self, segment: str | None = None, category: str | None = None,
                     warehouse_code: str | None = None) -> list:
        """Every open (un-actioned) excess position with its recommended disposition."""
        s = self._snapshot
        done_skus = {d["sku_code"] for d in s.get("dispositions", [])}
        rows = []
        for it in self._filter_inventory(None, category, segment, None, warehouse_code):
            if not it.get("is_excess") or it["sku_code"] in done_skus:
                continue
            excess, unit = it.get("excess_units", 0), it.get("unit_cost_gbp", 50)
            hubs_short = [w for w in it.get("by_warehouse", []) if w["role"] == "hub" and w["rag_status"] != "G"]
            if hubs_short:
                rec, recover = "rebalance", round(excess * unit * 0.95)
            elif it.get("xyz_class") == "Z":
                rec, recover = "return_to_vendor", round(excess * unit * 0.70)
            else:
                rec, recover = "markdown", round(excess * unit * 0.55)
            rows.append({"sku_code": it["sku_code"], "description": it["description"], "segment": it.get("segment"),
                         "excess_units": excess, "excess_value_gbp": round(excess * unit),
                         "recommended_disposition": rec, "recoverable_gbp": recover,
                         "holding_cost_pa_gbp": round(excess * unit * HOLDING_COST_RATE_PA)})
        rows.sort(key=lambda r: -r["excess_value_gbp"])
        return rows

    def get_excess_dispositions(self, page: int = 1, per_page: int = 10,
                                segment: str | None = None, category: str | None = None,
                                warehouse_code: str | None = None) -> dict:
        """POSITION · excess & obsolescence disposition — paged, so the count in the
        header and the rows on screen always agree."""
        rows = self._excess_rows(segment, category, warehouse_code)
        done = self._snapshot.get("dispositions", [])
        total = len(rows)
        per_page = max(1, min(100, per_page))
        pages = max(1, (total + per_page - 1) // per_page)
        page = max(1, min(page, pages))
        start = (page - 1) * per_page
        return {
            "open": rows[start:start + per_page],
            "open_count": total, "page": page, "per_page": per_page, "pages": pages,
            "actioned": done[:per_page], "actioned_count": len(done),
            "total_excess_gbp": round(sum(r["excess_value_gbp"] for r in rows)),
            "recoverable_gbp": round(sum(r["recoverable_gbp"] for r in rows)),
            "recovered_to_date_gbp": round(sum(d.get("recovered_gbp", 0) for d in done))}

    def apply_all_dispositions(self, max_items: int | None = None) -> dict:
        """Apply the recommended disposition to every open excess position (or the
        top `max_items` by value). Returns what was actioned and the capital recovered."""
        rows = self._excess_rows()
        if max_items:
            rows = rows[:max_items]
        applied = [self.create_disposition({"sku_code": r["sku_code"], "action": r["recommended_disposition"],
                                            "units": r["excess_units"], "notes": "Bulk disposition applied"})
                   for r in rows]
        return {"applied": len(applied),
                "recovered_gbp": round(sum(a.get("recovered_gbp", 0) for a in applied)),
                "items": applied[:20]}

    def create_disposition(self, data: dict) -> dict:
        s = self._snapshot
        now = datetime.now(timezone.utc)
        item = next((i for i in s.get("inventory_positions", []) if i["sku_code"] == data.get("sku_code")), None)
        excess, unit = (item or {}).get("excess_units", 0), (item or {}).get("unit_cost_gbp", 50)
        units = data.get("units") or excess
        rate = {"rebalance": 0.95, "return_to_vendor": 0.70, "markdown": 0.55, "write_off": 0.0}.get(data.get("action", "markdown"), 0.6)
        disp = {
            "disposition_id": f"DISP-{now.strftime('%H%M%S')}",
            "sku_code": data.get("sku_code"),
            "description": (item or {}).get("description", data.get("sku_code")),
            "action": data.get("action", "markdown"),
            "units": units, "recovered_gbp": round(units * unit * rate),
            "notes": data.get("notes"), "created_at": now.isoformat()}
        s.setdefault("dispositions", []).insert(0, disp)
        return disp

    def get_financials(self, segment: str | None = None, category: str | None = None,
                       warehouse_code: str | None = None) -> dict:
        """The financial lens: working capital, GMROI, turns and value at risk —
        over whatever slice of the catalogue the page is currently filtered to."""
        items = self._filter_inventory(None, category, segment, None, warehouse_code)
        stock_value = sum(i.get("stock_value_gbp", 0) for i in items)
        excess_value = sum(i.get("excess_value_gbp", 0) for i in items)
        holding = sum(i.get("annual_holding_cost_gbp", 0) for i in items)
        value_at_risk = sum((i.get("target_order_qty") or 0) * i.get("unit_cost_gbp", 50)
                            for i in items if i.get("rag_status") == "R")
        annual_cogs = sum(SKU_CONFIG.get(i["sku_code"], {}).get("daily_consumption", 10) * 365 * i.get("unit_cost_gbp", 50) for i in items)
        return {
            "stock_value_gbp": round(stock_value),
            "excess_value_gbp": round(excess_value),
            "value_at_risk_gbp": round(value_at_risk),
            "annual_holding_cost_gbp": round(holding),
            "gmroi": round(annual_cogs * 0.28 / stock_value, 2) if stock_value else None,
            "inventory_turns": round(annual_cogs / stock_value, 1) if stock_value else None,
            "working_capital_days": round(stock_value / (annual_cogs / 365), 1) if annual_cogs else None}

    @staticmethod
    def _page(rows: list, page: int, per_page: int) -> dict:
        """Uniform pagination envelope so every table on the page can show all of
        its records rather than a silently truncated head."""
        total = len(rows)
        per_page = max(1, min(200, per_page))
        pages = max(1, (total + per_page - 1) // per_page)
        page = max(1, min(page, pages))
        start = (page - 1) * per_page
        return {"items": rows[start:start + per_page], "total": total,
                "page": page, "per_page": per_page, "pages": pages}

    # Work-type families — the tab dimension. Grouped by the ACTION a planner
    # takes, so "raise a new PO" and "expedite an existing PO" are separate tabs
    # (they are genuinely different decisions), as are internal transfers, excess
    # reduction and supplier de-risking. Every row still shows only the attributes
    # relevant to its own type.
    _KIND_FAMILY = {
        "purchase": "raise_po", "stockout": "raise_po", "low_stock": "raise_po",
        "expedite": "expedite",
        "transfer": "transfer", "rebalance": "transfer",
        "excess": "reduce",
        "supplier": "derisk",
    }
    _FAMILY_META = {
        "raise_po": {"label": "Raise PO", "order": 0, "hint": "Bring new stock in — raise a supplier PO into the NDC"},
        "expedite": {"label": "Expedite", "order": 1, "hint": "Pull in an existing in-flight PO — no new order raised"},
        "transfer": {"label": "Transfer", "order": 2, "hint": "Move stock you already own — NDC → hub trunk or hub → hub rebalance"},
        "reduce":   {"label": "Reduce excess", "order": 3, "hint": "Free up capital tied in overstock — rebalance, return or mark down"},
        "derisk":   {"label": "De-risk", "order": 4, "hint": "Act on a supplier failing its OTIF target before it bites"},
    }
    _DISPOSITION_VERB = {"rebalance": "Rebalance", "return_to_vendor": "Return to vendor",
                         "markdown": "Mark down", "write_off": "Write off"}

    def get_planner_worklist(self, page: int = 1, per_page: int = 10, kind: str | None = None,
                             family: str | None = None, sort: str = "priority",
                             segment: str | None = None, category: str | None = None,
                             warehouse_code: str | None = None) -> dict:
        """LEARN · one prioritised worklist across the module. Each row is grouped
        into a work-type FAMILY (replenish / redistribute / reduce / de-risk) and
        carries only the context relevant to its own type — a route + quantity for a
        move, a cover gap for a shortage, a disposition for excess, an OTIF score and
        £ exposure for a supplier risk — plus an owner, an SLA and a single verb-clear
        action. The former Intelligent Replenishment Planner's DRP recommendations
        are the concrete moves in the Replenish/Redistribute families. Honours the
        page's segment/category/site filters so clicking an ABC/XYZ cell — or scoping
        to one site — narrows the work queue too."""
        s = self._snapshot
        scoped = self._filter_inventory(None, category, segment, None, warehouse_code)
        work = []
        prio_label = {1: "critical", 2: "high", 3: "medium", 4: "low"}

        def add(kind_, ref, desc, issue, value, sla_h, owner, action, priority, seg=None, **extra):
            # Every row states three things plainly: the ITEM (desc), a brief of the
            # ISSUE (what's wrong), and the RECOMMENDED ACTION (the fix the button
            # carries out). Kept as separate fields so the UI never has to parse prose.
            work.append({"id": f"{kind_}-{ref}", "kind": kind_,
                         "family": self._KIND_FAMILY.get(kind_, "replenish"),
                         "sku_code": ref, "description": desc, "issue": issue,
                         "title": f"{desc} — {issue}" if issue else desc,
                         "segment": seg, "value_at_risk_gbp": round(value), "sla_hours": sla_h,
                         "owner": owner, "recommended_action": action,
                         "priority": priority, "priority_label": prio_label[priority], **extra})

        # ── REPLENISH / REDISTRIBUTE · concrete moves from the DRP engine: expedite
        # or raise a PO into the NDC, trunk NDC → hub, or laterally rebalance hub →
        # hub. A concrete move supersedes the generic stockout/low-stock flag. The
        # rec's `reason` is the issue brief; `action` below is the matching fix.
        site_scope = warehouse_code if warehouse_code and warehouse_code != "NETWORK" else None
        routed_skus = set()
        for r in self._drp_recommendations(category, segment):
            if site_scope and site_scope not in (r.get("from_code"), r.get("to_code")):
                continue
            route_txt = f"{r['from_name']} → {r['to_name']}"
            action = {
                "purchase":  f"Raise a PO to {r['from_name']} for {r['quantity']:,} units ({r['eta_days']}d lead)",
                "expedite":  f"Expedite the in-flight PO via {r['from_name']} ({r['eta_days']}d)",
                "transfer":  f"Transfer {r['quantity']:,} units {route_txt} ({r['eta_days']}d)",
                "rebalance": f"Rebalance {r['quantity']:,} units {route_txt} ({r['eta_days']}d)",
            }[r["type"]]
            add(r["type"], r["sku_code"], r["description"], r["reason"], r["impact_gbp"],
                8 if r["priority"] == 1 else 24, "Replenishment planner", action, r["priority"], r.get("segment"),
                id=r["rec_id"], from_code=r.get("from_code"), from_name=r.get("from_name"),
                to_code=r.get("to_code"), to_name=r.get("to_name"),
                quantity=r.get("quantity"), eta_days=r.get("eta_days"),
                po_number=r.get("po_number"), net_benefit_gbp=r.get("net_benefit_gbp"))
            routed_skus.add(r["sku_code"])

        # ── REPLENISH fallback · an at-risk position the DRP pass didn't already
        # cover — surfaced with its own cover gap so nothing drops off the queue.
        at_site_default = site_scope or "NETWORK"
        for it in scoped:
            sku, unit, seg = it["sku_code"], it.get("unit_cost_gbp", 50), it.get("segment")
            if sku in routed_skus:
                continue
            dos = it.get("days_of_supply")
            cover = None if dos is None or dos >= 900 else dos
            common = dict(at_site=it.get("warehouse_code", at_site_default), cover_days=cover,
                          lead_days=it.get("lead_time_days"), quantity=it.get("target_order_qty"))
            if it.get("rag_status") == "R":
                add("stockout", sku, it["description"],
                    f"Critical — {dos}d cover vs {it['lead_time_days']}d supplier lead",
                    (it.get("target_order_qty") or 0) * unit, 8, "Replenishment planner",
                    "Raise or expedite a PO into the NDC", 1, seg, **common)
            elif it.get("rag_status") == "A":
                add("low_stock", sku, it["description"],
                    f"Inside the reorder window — {cover}d cover" if cover is not None else "Inside the reorder window",
                    (it.get("target_order_qty") or 0) * unit * 0.5, 24, "Replenishment planner",
                    "Raise a replenishment PO to the NDC", 2, seg, **common)

        # ── REDUCE · open excess with its recommended disposition and recoverable £.
        # Reuses the disposition engine so positions already actioned drop off.
        for ex in self._excess_rows(segment, category, warehouse_code):
            verb = self._DISPOSITION_VERB.get(ex["recommended_disposition"], "Disposition")
            add("excess", ex["sku_code"], ex["description"],
                f"Overstocked — {ex['excess_units']:,} units above target, £{ex['excess_value_gbp']:,.0f} tied up",
                ex["excess_value_gbp"], 72, "Inventory analyst",
                f"{verb} the excess — recover £{ex['recoverable_gbp']:,.0f}", 3, ex.get("segment"),
                at_site=at_site_default, excess_units=ex["excess_units"],
                recoverable_gbp=ex["recoverable_gbp"], disposition=ex["recommended_disposition"])

        # ── DE-RISK · portfolio supplier OTIF risk — only when not narrowed to a slice
        if not (segment and segment != "all") and not (category and category != "all"):
            open_pos = [p for p in s.get("purchase_orders", []) if p.get("status") in ("draft", "confirmed", "in_transit")]
            for sc in s.get("supplier_scorecards", []):
                if (sc.get("otif_score") or 100) < 80:
                    code, name = sc.get("supplier_code", "?"), sc.get("name", sc.get("supplier_code", "?"))
                    exposed = [p for p in open_pos if p.get("supplier_code") == code]
                    exposure = round(sum(p.get("total_value_gbp") or 0 for p in exposed))
                    issue = (f"OTIF {sc.get('otif_score')}% — below 80% target, £{exposure:,.0f} exposed across "
                             f"{len(exposed)} open PO{'s' if len(exposed) != 1 else ''}") if exposed \
                        else f"OTIF {sc.get('otif_score')}% — below 80% target"
                    add("supplier", code, name, issue,
                        exposure, 168, "Supply-chain manager", "Capacity review / consider dual-sourcing", 4,
                        from_code=code, from_name=name, to_code=NDC_CODE, to_name="Leicester NDC",
                        otif_score=sc.get("otif_score"), open_po_count=len(exposed))

        # Summaries span the WHOLE queue (before any family/kind filter) so the
        # segment controls always show full counts — like unread badges on a folder.
        fam_sum: dict = {}
        for w in work:
            f = w["family"]
            e = fam_sum.setdefault(f, {"key": f, "label": self._FAMILY_META[f]["label"],
                                       "hint": self._FAMILY_META[f]["hint"], "order": self._FAMILY_META[f]["order"],
                                       "count": 0, "value_gbp": 0, "critical": 0})
            e["count"] += 1
            e["value_gbp"] += w["value_at_risk_gbp"]
            if w["priority"] == 1:
                e["critical"] += 1
        families = sorted(fam_sum.values(), key=lambda e: e["order"])
        all_kinds = sorted({w["kind"] for w in work})
        total_var = round(sum(w["value_at_risk_gbp"] for w in work))
        total_critical = len([w for w in work if w["priority"] == 1])

        if family and family != "all":
            work = [w for w in work if w["family"] == family]
        if kind and kind != "all":
            work = [w for w in work if w["kind"] == kind]
        sorters = {
            "priority": lambda w: (w["priority"], -w["value_at_risk_gbp"]),
            "value":    lambda w: -w["value_at_risk_gbp"],
            "benefit":  lambda w: -(w.get("net_benefit_gbp") or 0),
            "sla":      lambda w: (w["sla_hours"], w["priority"]),
            "sku":      lambda w: w["sku_code"],
        }
        work.sort(key=sorters.get(sort, sorters["priority"]))
        env = self._page(work, page, per_page)
        return {**env,
                "total_value_at_risk_gbp": total_var,
                "critical": total_critical,
                "kinds": all_kinds,
                "families": families,
                "generated_at": datetime.now(timezone.utc).isoformat()}

    def get_forecast_tuning(self, page: int = 1, per_page: int = 10, sort: str = "bias",
                            segment: str | None = None, category: str | None = None,
                            warehouse_code: str | None = None,
                            top_pct: float | None = None) -> dict:
        """LEARN → POSITION · portfolio forecast bias and the buffer-policy nudge it
        implies. Persistent over-forecasting trims buffers; under-forecasting lifts
        them — the feedback that closes the loop.

        top_pct switches from page/per_page pagination to a fixed top-N-by-impact
        slice — what the tuning-loop chart needs (its top `top_pct`% by impact)
        rather than a browsable table."""
        items = self._filter_inventory(None, category, segment, None, warehouse_code)
        rows = []
        for it in items:
            fq = it.get("forecast_quality") or {}
            bias = fq.get("bias_pct", 0)
            value = it.get("stock_value_gbp", 0)
            nudge = "trim safety stock" if bias > 3 else ("raise safety stock" if bias < -3 else "hold")
            rows.append({"sku_code": it["sku_code"], "description": it["description"], "segment": it.get("segment"),
                         "mape_pct": fq.get("mape_pct"), "bias_pct": bias, "fva_pct": fq.get("fva_pct"),
                         "stock_value_gbp": value, "policy_nudge": nudge,
                         # £ at stake from the mis-forecast, not just the SKU's size —
                         # a cheap SKU with wild bias can outrank an expensive stable one
                         "impact_score": round(abs(bias) * value)})
        total_w = sum(i.get("stock_value_gbp", 0) for i in items) or 1
        wmape = sum((i.get("forecast_quality", {}).get("mape_pct", 0)) * i.get("stock_value_gbp", 0) for i in items) / total_w
        mean_bias = sum(i.get("forecast_quality", {}).get("bias_pct", 0) for i in items) / len(items) if items else 0
        sorters = {
            "bias":   lambda r: -abs(r["bias_pct"] or 0),
            "mape":   lambda r: -(r["mape_pct"] or 0),
            "value":  lambda r: -(r["stock_value_gbp"] or 0),
            "impact": lambda r: -(r["impact_score"] or 0),
            "sku":    lambda r: r["sku_code"],
        }
        rows.sort(key=sorters.get(sort, sorters["bias"]))

        if top_pct is not None:
            total = len(rows)
            n_plot = math.ceil(total * top_pct / 100) if total else 0
            plotted = rows[:n_plot]
            return {"rows": plotted, "row_count": total, "plotted_count": len(plotted),
                    "portfolio_wmape_pct": round(wmape, 1), "mean_bias_pct": round(mean_bias, 1)}

        env = self._page(rows, page, per_page)
        return {**env, "rows": env["items"], "row_count": env["total"],
                "portfolio_wmape_pct": round(wmape, 1), "mean_bias_pct": round(mean_bias, 1),
                "skus_needing_tuning": len([r for r in rows if r["policy_nudge"] != "hold"])}

    def get_sop_plan(self, periods: int = 6) -> dict:
        """ORCHESTRATE · tactical S&OP — a monthly demand / supply / financial
        reconciliation per category, plus a constrained-supply allocation for the
        long-lead heat-pump programme where OEM capacity, not the warehouse, is the
        true bottleneck."""
        s = self._snapshot
        items = s.get("inventory_positions", [])
        start_month = datetime.now(timezone.utc).month
        cats = ["boiler", "heat_pump", "smart_meter", "ev_charger"]
        cat_daily = {c: 0.0 for c in cats}
        cat_cost = {c: [] for c in cats}
        for it in items:
            c = it.get("category")
            if c in cat_daily:
                cat_daily[c] += it.get("daily_consumption_adjusted", 0)
                cat_cost[c].append(it.get("unit_cost_gbp", 50))
        # OEM factories run at a broadly FLAT monthly rate while demand is seasonal —
        # that mismatch is the whole point of S&OP. Capacity is therefore sized off
        # average demand across the horizon (scaled by OEM reliability), so peak
        # months fall short and shoulder months do not.
        oems = self.get_heat_pump_pipeline().get("oems", [])
        oem_reliability = (sum(o.get("otif") or 85 for o in oems) / len(oems) / 100) if oems else 0.85
        rows = []
        for c in cats:
            avg_cost = sum(cat_cost[c]) / len(cat_cost[c]) if cat_cost[c] else 50
            curve = _SEASONALITY.get(c, [1.0] * 12)
            months = [(start_month - 1 + p) % 12 for p in range(periods)]
            demands = [round(cat_daily[c] * 30 * curve[m]) for m in months]
            # Flat capacity for the long-lead, capacity-constrained heat-pump programme
            hp_capacity = round(sum(demands) / len(demands) * oem_reliability) if demands else 0
            periods_out = []
            for i, m in enumerate(months):
                demand = demands[i]
                # 2dp so the supply factor doesn't round to exactly 1.0 and sit on top of demand
                supply = hp_capacity if c == "heat_pump" else round(demand * rnd(0.94, 1.09, 2))
                periods_out.append({"month": m + 1, "demand_units": demand, "supply_units": supply,
                                    "gap_units": supply - demand, "constrained": supply < demand,
                                    "value_gbp": round(demand * avg_cost)})
            rows.append({"category": c, "avg_unit_cost_gbp": round(avg_cost), "periods": periods_out})
        hp_next = rows[cats.index("heat_pump")]["periods"][0]
        shares = WAREHOUSE_ALLOCATION.get("heat_pump", _DEFAULT_ALLOCATION)
        alloc = []
        for code, frac in shares.items():
            want, give = round(hp_next["demand_units"] * frac), round(hp_next["supply_units"] * frac)
            alloc.append({"site": code, "site_name": next((w["name"] for w in WAREHOUSES_DATA if w["code"] == code), code),
                          "requested": want, "allocated": min(want, give), "shortfall": max(0, want - give)})
        return {
            "horizon_months": periods, "categories": rows,
            "heat_pump_allocation": {"supply_units": hp_next["supply_units"], "demand_units": hp_next["demand_units"],
                                     "constrained": hp_next["supply_units"] < hp_next["demand_units"], "by_site": alloc},
            "engine": "S&OP reconciliation · constrained allocation for long-lead OEM capacity"}

    def simulate_network(self, demand_shock_pct: float = 0, lead_slip_days: int = 0, category: str | None = None) -> dict:
        """ORCHESTRATE · digital-twin what-if at network scale. Apply a demand shock
        and/or supply slip to the current positions WITHOUT mutating state, and
        report how many SKUs tip critical, the units short and the £ to recover."""
        s = self._snapshot
        results, crit_before, crit_after, expedite_cost = [], 0, 0, 0.0
        for it in s.get("inventory_positions", []):
            if category and category != "all" and it.get("category") != category:
                continue
            unit = it.get("unit_cost_gbp", 50)
            daily = it.get("daily_consumption_adjusted", 1) * (1 + demand_shock_pct / 100.0)
            lead = it["lead_time_days"] + lead_slip_days
            available = it.get("quantity_available", 0)
            dos_after = round(available / daily, 1) if daily > 0 else 999.9
            was_crit = it.get("rag_status") == "R"
            now_crit = available == 0 or dos_after < lead
            crit_before += 1 if was_crit else 0
            crit_after += 1 if now_crit else 0
            short = max(0, round(daily * lead - available)) if now_crit else 0
            if short:
                expedite_cost += short * unit * (1 + EXPEDITE_PREMIUM_RATE)
            results.append({"sku_code": it["sku_code"], "description": it["description"],
                            "dos_after": dos_after if dos_after < 900 else None,
                            "newly_critical": now_crit and not was_crit, "units_short": short})
        results.sort(key=lambda r: -(r["units_short"] or 0))
        return {
            "inputs": {"demand_shock_pct": demand_shock_pct, "lead_slip_days": lead_slip_days, "category": category or "all"},
            "critical_before": crit_before, "critical_after": crit_after,
            "newly_critical": len([r for r in results if r["newly_critical"]]),
            "total_units_short": sum(r["units_short"] or 0 for r in results),
            "expedite_cost_gbp": round(expedite_cost), "skus": results}

    def expedite_purchase_order(self, po_number: str) -> dict:
        """EXECUTE · expedite an EXISTING in-flight PO — upgrade it to emergency
        handling and pull the delivery in to the emergency lead — rather than
        raising a brand-new order. Idempotent: re-expediting a PO already on the
        emergency track just refreshes its pulled-in ETA."""
        s = self._snapshot
        now = datetime.now(timezone.utc)
        po = next((p for p in s.get("purchase_orders", []) if p.get("po_number") == po_number), None)
        if not po:
            return {}
        if po.get("status") == "received":
            return po  # already delivered — nothing to expedite
        eta = now + timedelta(days=2)
        po.update({
            "po_type": "emergency",
            "is_expedited": True,
            "expedited_at": now.isoformat(),
            "expected_delivery": eta.isoformat(),
            "notes": ((po.get("notes") or "") + " · Expedited to emergency lead").strip(" ·"),
        })
        # The freight against this PO moves with it — an expedited order whose
        # shipment still shows the old ETA is the same PO/shipment drift the
        # linkage exists to prevent.
        for sh in s.get("shipments", []):
            if sh.get("po_number") == po_number:
                sh.update({"scheduled_arrival": eta.isoformat(), "predicted_arrival": eta.isoformat(),
                           "delay_hours": 0, "alert_raised": False, "status": "in_transit",
                           "carrier": "Palletforce HGV (expedited)"})
        return po

    def receive_purchase_order(self, po_number: str) -> dict:
        """EXECUTE · goods receipt — book an inbound PO into the NDC and close it
        off with a GRN and a 3-way match."""
        s = self._snapshot
        now = datetime.now(timezone.utc)
        po = next((p for p in s.get("purchase_orders", []) if p.get("po_number") == po_number), None)
        if not po:
            return {}
        po.update({"status": "received", "received_qty": po.get("quantity"),
                   "received_at": now.isoformat(), "goods_receipt_note": f"GRN-{po_number.split('-')[-1]}",
                   "three_way_match": "matched"})
        # Goods are booked in, so the freight leg is over: the shipment leaves the
        # inbound board with the PO that raised it.
        s["shipments"] = [sh for sh in s.get("shipments", []) if sh.get("po_number") != po_number]
        item = next((i for i in s.get("inventory_positions", []) if i["sku_code"] == po.get("sku_code")), None)
        if item and po.get("quantity"):
            item["quantity_on_hand"] += po["quantity"]
            self._recompute_inventory_dos()
        return po

    def receive_transfer(self, transfer_id: str) -> dict:
        """EXECUTE · the requesting hub posts the goods receipt, closing the STO."""
        s = self._snapshot
        now = datetime.now(timezone.utc)
        t = next((x for x in s.get("transfer_orders", []) if x.get("transfer_id") == transfer_id), None)
        if not t:
            return {}
        t.update({"status": "delivered", "received_at": now.isoformat(),
                  "goods_receipt_at": now.isoformat(),
                  "goods_receipt_note": f"GRN-{transfer_id.split('-')[-1]}"})
        return t

    def advance_sto_lifecycle(self, max_moves: int = 6) -> list:
        """Move open STOs along the SAP flow on each tick: the supplying plant
        confirms and picks (requested → picking), posts goods issue
        (picking → in_transit), and the requesting hub posts receipt on arrival."""
        s = self._snapshot
        now = datetime.now(timezone.utc)
        moved = []
        for t in s.get("transfer_orders", []):
            if len(moved) >= max_moves:
                break
            st = t.get("status")
            if st == "requested":
                t["status"] = "picking"
                t["confirmed_at"] = now.isoformat()
                moved.append(t)
            elif st == "picking":
                t["status"] = "in_transit"
                t["goods_issue_at"] = now.isoformat()
                moved.append(t)
            elif st == "in_transit":
                eta = t.get("expected_arrival")
                if eta and datetime.fromisoformat(eta) <= now:
                    self.receive_transfer(t["transfer_id"])
                    moved.append(t)
        return moved

    def get_reference_data(self) -> dict:
        """The module's master data — network topology, supplier master and the
        category list — served from the state engine so the UI never keeps its own
        copy. Previously the frontend hard-coded all three, which meant a supplier
        added here would never appear in the raise-PO picker."""
        s = self._snapshot
        inv = s.get("inventory_positions", [])

        cat_counts, cat_suppliers = {}, {}
        for i in inv:
            cat = i.get("category")
            if not cat:
                continue
            cat_counts[cat] = cat_counts.get(cat, 0) + 1
            if i.get("primary_supplier"):
                cat_suppliers.setdefault(cat, set()).add(i["primary_supplier"])

        sites = []
        for w in WAREHOUSES_DATA:
            is_ndc = w["code"] == NDC_CODE
            sites.append({
                "code": w["code"], "name": w["name"],
                "short": "NDC" if is_ndc else w["code"].split("_")[0][:3].upper(),
                "role": "ndc" if is_ndc else "hub",
                "replenished_by": "Purchase Order (supplier)" if is_ndc else "Stock Transport Order (raised on the NDC)",
                "transfer_lead_days": None if is_ndc else HUB_TRANSFER_LEAD_DAYS.get(w["code"], 2)},)

        by_code = {sp["supplier_code"]: sp for sp in SUPPLIER_DATA}
        scorecards = {sc.get("supplier_code"): sc for sc in s.get("supplier_scorecards", [])}
        po_counts: dict = {}
        for po in s.get("purchase_orders", []):
            code = po.get("supplier_code")
            if code:
                po_counts[code] = po_counts.get(code, 0) + 1
        suppliers = [{
            "code": sp["supplier_code"], "name": sp["name"], "category": sp.get("category"),
            "country_code": sp.get("country_code"), "is_tier1": sp.get("is_tier1"),
            "otif": scorecards.get(sp["supplier_code"], {}).get("otif_score", sp.get("otif_base")),
            "sku_count": sum(1 for i in inv if i.get("primary_supplier") == sp["supplier_code"]),
            # Drives the PO-queue supplier filter, so the picker shows real volume
            "po_count": po_counts.get(sp["supplier_code"], 0)}
            for sp in SUPPLIER_DATA]

        return {
            "sites": sites,
            "ndc_code": NDC_CODE,
            "hub_codes": list(HUB_CODES),
            "suppliers": suppliers,
            # Which suppliers actually source each category — drives the PO picker
            "suppliers_by_category": {
                cat: sorted(
                    ({"code": c, "name": by_code.get(c, {}).get("name", c)} for c in codes),
                    key=lambda x: x["name"])
                for cat, codes in cat_suppliers.items()
            },
            "categories": [
                {"code": cat, "label": cat.replace("_", " ").title(), "sku_count": n}
                for cat, n in sorted(cat_counts.items(), key=lambda kv: -kv[1])
            ],
            "catalogue_size": len(inv)}

    def get_replenishment_routing(self) -> dict:
        """The network's replenishment policy, stated explicitly: which document
        type fills a shortfall at which echelon, and who raises it."""
        s = self._snapshot
        items = s.get("inventory_positions", [])
        ndc_short = hub_short = 0
        for it in items:
            for w in it.get("by_warehouse", []):
                if w["rag_status"] == "G":
                    continue
                if w["warehouse_code"] == NDC_CODE:
                    ndc_short += 1
                else:
                    hub_short += 1
        open_pos = [p for p in s.get("purchase_orders", []) if p.get("status") in ("draft", "confirmed", "in_transit")]
        open_stos = [t for t in s.get("transfer_orders", []) if t.get("status") in self.STO_OPEN_STATUSES]
        return {
            "rules": [
                {
                    "echelon": "Leicester NDC", "site": NDC_CODE, "role": "ndc",
                    "shortfall_filled_by": "Purchase Order (PO)",
                    "raised_by": "Central replenishment planner",
                    "supplied_by": "External supplier / OEM",
                    "doc_type": "NB — standard purchase order",
                    "typical_lead": "2–112 days depending on supplier",
                    "why": "The NDC is the only site suppliers deliver into, so a national shortfall is closed by buying more stock.",
                    "positions_short": ndc_short, "open_docs": len(open_pos)},
                {
                    "echelon": "Regional hubs", "site": "COV_HUB / MAN_HUB / CAR_HUB", "role": "hub",
                    "shortfall_filled_by": "Stock Transport Order (STO)",
                    "raised_by": "The hub itself — the receiving plant raises the STO",
                    "supplied_by": "Leicester NDC (or a sister hub on a lateral rebalance)",
                    "doc_type": "UB — intra-company STO, NL replenishment delivery",
                    "typical_lead": "1–2 days by trunker",
                    "why": "Hubs never buy direct. A hub shortfall is a positioning problem, not a buying problem — the stock already exists in the network.",
                    "positions_short": hub_short, "open_docs": len(open_stos)},
            ],
            "flow": [
                {"step": 1, "actor": "Requesting hub", "action": "Raises the STO on the supplying plant (status: requested)"},
                {"step": 2, "actor": "Leicester NDC", "action": "Confirms and picks the replenishment delivery (status: picking)"},
                {"step": 3, "actor": "Leicester NDC", "action": "Posts goods issue; trunker departs (status: in transit)"},
                {"step": 4, "actor": "Requesting hub", "action": "Posts goods receipt against the STO (status: delivered)"},
            ],
            "escalation": "If the NDC cannot cover a hub request above its own safety stock, the DRP engine sources laterally from a sister hub holding surplus; only a national shortfall escalates to a supplier PO."}

    @staticmethod
    def _kpi(value: float, target: float, unit: str, lower_better: bool = False) -> dict:
        """KPI entry with RAG computed from value vs target — the baseline is a
        'usual day' where one or two KPIs naturally drift amber."""
        if lower_better:
            rag = "G" if value <= target else ("A" if value <= target * 1.35 else "R")
        else:
            rag = "G" if value >= target else ("A" if value >= target * 0.92 else "R")
        return {"value": value, "target": target, "unit": unit, "rag": rag}

    def _gen_kpis(self) -> dict:
        # Ranges deliberately straddle targets so the normal state reads like a
        # real control tower (mostly green, occasional amber) not a demo in a jar.
        return {
            "first_time_fix_rate": self._kpi(rnd(80, 92), 82, "pct"),
            "pre_8am_success_rate": self._kpi(rnd(92, 99), 95, "pct"),
            "in_boot_availability": self._kpi(rnd(88, 97), 90, "pct"),
            "expediting_cost_pct": self._kpi(rnd(1.6, 3.6), 3.0, "pct", lower_better=True),
            "supplier_otif": self._kpi(rnd(88, 97), 92, "pct"),
            "landfill_diversion": self._kpi(rnd(93, 99), 95, "pct"),
            "scope3_emissions_ytd": self._kpi(rnd(1700, 2050), 2000, "tco2e", lower_better=True),
            "p1_response_time_min": self._kpi(rnd(2, 5.5), 5, "minutes", lower_better=True)}

    def _gen_exceptions_summary(self, exceptions: list) -> dict:
        return {
            "total_open": len([e for e in exceptions if e["status"] == "open"]),
            "p1": len([e for e in exceptions if e["priority"] == "P1" and e["status"] == "open"]),
            "p2": len([e for e in exceptions if e["priority"] == "P2" and e["status"] == "open"]),
            "p3": len([e for e in exceptions if e["priority"] == "P3" and e["status"] == "open"]),
            "p4": len([e for e in exceptions if e["priority"] == "P4" and e["status"] == "open"])}

    def _gen_demand_signals(self) -> dict:
        """UK home-services demand drivers. Seasonality follows the real heating
        calendar: Oct–Mar peak heating (breakdown-led), Sep the boiler switch-on
        surge, Jun–Aug the summer servicing window (planned-work-led)."""
        month = datetime.now(timezone.utc).month
        if month in (10, 11, 12, 1, 2, 3):
            season, in_heating_season = "peak_heating", True
        elif month == 9:
            season, in_heating_season = "switch_on_shoulder", True
        elif month in (4, 5):
            season, in_heating_season = "spring_shoulder", False
        else:
            season, in_heating_season = "summer_servicing", False

        temp = rnd(-2, 8) if in_heating_season else rnd(9, 22)
        forecast_min = rnd(-4, 4) if in_heating_season else rnd(5, 12)
        # Heating degree days (base 15.5°C) over the next 7 days — the classic
        # UK boiler-demand predictor
        hdd = round(max(0.0, (15.5 - forecast_min)) * 7 * rnd(0.6, 0.9), 1)

        return {
            "weather": {
                "source": "Met Office",
                "region": "East Midlands",
                "temp_c": temp,
                "forecast_7d_min_c": forecast_min,
                "heating_degree_days_7d": hdd,
                "demand_uplift_factor": rnd(1.12, 1.28),
                "beast_from_east_risk": False,
                # Frozen condensate pipes are the #1 cold-snap boiler lockout cause in the UK
                "frozen_condensate_risk": forecast_min <= -2,
                "named_storm": None},
            "hive_faults": {
                "high_probability_signals_24h": random.randint(2200, 3500),
                # Same fact the IoT module reports — read its pipeline rather than
                # hard-coding a second answer that can disagree with it.
                "top_fault_type": self._modal_fault_type(),
                "pre_positioning_triggered_today": random.randint(180, 320),
                "condensate_lockout_signals_24h": random.randint(120, 380) if in_heating_season else random.randint(5, 40)},
            # HomeCare service book — planned annual services + reactive breakdowns
            "service_book": {
                "season": season,
                "homecare_contracts_active": 184_000,
                "annual_services_due_30d": random.randint(12_500, 15_800) if not in_heating_season else random.randint(6_200, 8_400),
                "breakdown_callouts_24h": random.randint(1_800, 2_600) if season == "peak_heating" else random.randint(550, 950),
                "boiler_switch_on_surge_risk": month in (9, 10)},
            # Government policy & grant programmes that pull installs forward
            "policy_signals": {
                "bus_grant_applications_30d": random.randint(1_400, 1_950),   # Boiler Upgrade Scheme £7,500
                "eco4_referrals_30d": random.randint(380, 520),
                "ev_chargepoint_grant_claims_30d": random.randint(240, 380),  # OZEV
                "price_cap_next_change": self._next_price_cap_date(),
                "price_cap_direction": random.choice(["up", "down"]),
                "smart_meter_booking_uplift_pct": rnd(6, 14)},
            "cpq_pipeline": {
                "heat_pump_boms_active": random.randint(890, 1200),
                "smart_meter_boms_active": random.randint(4200, 5100),
                "ev_charger_boms_active": random.randint(320, 450)},
            "mhhs_schedule": {
                "smart_meters_target_q3": 48000,
                "installed_ytd": random.randint(31000, 38000),
                "install_rate_per_week": random.randint(800, 1200)},}

    def _modal_fault_type(self) -> str:
        """Most common fault in the live IoT pipeline — the demand signal quotes
        the IoT module's own data instead of keeping a parallel hard-coded copy."""
        pipeline = self._snapshot.get("boiler_fault_pipeline") or []
        counts: dict = {}
        for f in pipeline:
            ft = f.get("fault_type")
            if ft:
                counts[ft] = counts.get(ft, 0) + 1
        return max(counts, key=counts.get) if counts else "diverter_valve_failure"

    @staticmethod
    def _next_price_cap_date() -> str:
        """Ofgem resets the domestic price cap on 1 Jan / Apr / Jul / Oct."""
        today = date.today()
        for m in (1, 4, 7, 10):
            candidate = date(today.year, m, 1)
            if candidate > today:
                return candidate.isoformat()
        return date(today.year + 1, 1, 1).isoformat()

    def _gen_heat_pump_pipeline(self) -> dict:
        """Stable programme facts only. Everything that can be observed from the
        network (OEMs, lead times, open POs, OTIF) is derived live in
        get_heat_pump_pipeline() rather than frozen here."""
        return {
            "installs_target_fy": 12000,
            "installs_ytd": random.randint(4200, 5800),
            "engineers_heat_pump_certified": random.randint(280, 350)}

    def get_heat_pump_pipeline(self) -> dict:
        """Heat-pump OEM pipeline, derived from live state rather than hard-coded:
        OEMs come from the supplier master, lead times from the SKUs they actually
        source, open POs are counted from the real PO book, and OTIF reads the live
        scorecard — so a supplier-OTIF scenario moves this panel too."""
        s = self._snapshot
        inv = s.get("inventory_positions", [])
        pos = [p for p in s.get("purchase_orders", []) if p.get("status") in ("draft", "confirmed", "in_transit")]
        scorecards = {sc.get("supplier_code"): sc for sc in s.get("supplier_scorecards", [])}
        today = date.today()

        oems = []
        for idx, sup in enumerate(sp for sp in SUPPLIER_DATA if sp.get("category") == "heat_pump"):
            code = sup["supplier_code"]
            skus = [i for i in inv if i.get("primary_supplier") == code]
            leads = [i["lead_time_days"] for i in skus if i.get("lead_time_days")]
            open_pos = [p for p in pos if p.get("supplier_code") == code]
            sc = scorecards.get(code, {})
            # HGV slots run weekly per OEM, staggered across the week
            days_ahead = (7 - today.weekday() + idx * 2) % 7 or 7
            oems.append({
                "supplier_code": code,
                "name": sup["name"],
                "lead_time_weeks": round(sum(leads) / len(leads) / 7) if leads else None,
                "sku_count": len(skus),
                "open_pos": len(open_pos),
                "open_po_value_gbp": round(sum(p.get("total_value_gbp") or 0 for p in open_pos)),
                "otif": sc.get("otif_score", sup.get("otif_base")),
                "next_hgv_slot": (today + timedelta(days=days_ahead)).isoformat(),
                # One pallet booking per ~3 open POs, so the figure tracks real volume
                "palletforce_bookings": max(1, -(-len(open_pos) // 3)) if open_pos else 0},)
        # Scenario disruption is layered on top of the observed values, so a demo
        # can still block an OEM or stretch lead times without the derivation
        # overwriting it on the next read.
        oems = [self._apply_oem_overrides(o) for o in oems]
        oems.sort(key=lambda o: -(o["open_pos"] or 0))
        stable = s.get("heat_pump_pipeline", {})
        out = {
            "oems": oems,
            "installs_target_fy": stable.get("installs_target_fy", 12000),
            "installs_ytd": stable.get("installs_ytd", 0),
            "engineers_heat_pump_certified": stable.get("engineers_heat_pump_certified", 0)}
        for k in ("capacity_alert", "surge_notes"):
            if k in stable:
                out[k] = stable[k]
        return out

    def _apply_oem_overrides(self, oem: dict) -> dict:
        """Merge any scenario-applied OEM disruption over the derived figures.
        Absolute values replace; `<field>_delta` values shift the observed number."""
        ov = (self._snapshot.get("heat_pump_pipeline", {}) or {}).get("oem_overrides", {}) or {}
        o = ov.get(oem.get("supplier_code")) or ov.get(oem.get("name")) or {}
        if not o:
            return oem
        for field in ("lead_time_weeks", "open_pos", "otif", "next_hgv_slot",
                      "palletforce_bookings", "status"):
            if field in o:
                oem[field] = o[field]
            delta = o.get(f"{field}_delta")
            if delta is not None and isinstance(oem.get(field), (int, float)):
                oem[field] = oem[field] + delta
        if isinstance(oem.get("lead_time_weeks"), (int, float)):
            oem["lead_time_weeks"] = max(1, min(99, round(oem["lead_time_weeks"])))
        if isinstance(oem.get("otif"), (int, float)):
            oem["otif"] = max(0, min(100, round(oem["otif"], 1)))
        if isinstance(oem.get("open_pos"), (int, float)):
            oem["open_pos"] = max(0, int(oem["open_pos"]))
        oem["disrupted"] = True
        return oem

    def _set_oem_override(self, key: str, **fields) -> None:
        """Record a scenario's OEM disruption. `*_delta` fields accumulate so a
        recovery step can walk back an earlier disruption."""
        hp = self._snapshot.setdefault("heat_pump_pipeline", {})
        ov = hp.setdefault("oem_overrides", {})
        cur = ov.setdefault(key, {})
        for k, v in fields.items():
            if k.endswith("_delta") and isinstance(v, (int, float)):
                cur[k] = cur.get(k, 0) + v
            else:
                cur[k] = v

    def _heat_pump_oem_codes(self) -> list:
        return [sp["supplier_code"] for sp in SUPPLIER_DATA if sp.get("category") == "heat_pump"]

    def _gen_smart_meter_dashboard(self) -> dict:
        """Stable programme facts only — live stock is derived on read."""
        return {
            "mhhs_progress_target": 48000,
            "smet2_certified_engineers": {"british_gas": random.randint(1800, 2200), "ph_jones": random.randint(600, 900)},
            "dcc_registration_rate": rnd(96, 99)}

    def get_smart_meter_dashboard(self) -> dict:
        """Smart-meter programme view. Kit stock is the REAL smart-meter inventory
        in the network rather than an invented number, and installed-to-date reads
        the same MHHS figure the demand signals use, so the two can never disagree."""
        s = self._snapshot
        stable = s.get("smart_meter_dashboard", {})
        sm = [i for i in s.get("inventory_positions", []) if i.get("category") == "smart_meter"]
        available = sum(i.get("quantity_available", 0) for i in sm)
        # Operating-company split of the same physical stock (BG runs the larger book)
        BG_SHARE = 0.72
        mhhs = s.get("demand_signals", {}).get("mhhs_schedule", {})
        installed = mhhs.get("installed_ytd", 0)
        target = mhhs.get("smart_meters_target_q3", stable.get("mhhs_progress_target", 48000))
        return {
            "kits_in_stock": {
                "british_gas": round(available * BG_SHARE),
                "ph_jones": round(available * (1 - BG_SHARE)),
                "total_available": available,
                "sku_count": len(sm)},
            "mhhs_progress": {
                "installed_ytd": installed,
                "target": target,
                "install_rate_per_week": mhhs.get("install_rate_per_week"),
                "pct_complete": round(installed / target * 100, 1) if target else None},
            "smet2_certified_engineers": stable.get("smet2_certified_engineers", {}),
            "dcc_registration_rate": stable.get("dcc_registration_rate")}

    def _gen_boiler_faults(self, now: datetime) -> list:
        """Raw telemetry only — what the device reported, not what we decided to do
        about it. The pre-positioning and outreach calls are derived in
        get_fault_pipeline() from real parts cover, so they cannot drift away from
        the stock that has to back them."""
        faults = []
        for i in range(20):
            region = random.choice(UK_REGIONS)
            brand = random.choice(BOILER_BRANDS)
            fault_type = random.choices(FAULT_TYPES, weights=[35, 28, 22, 10, 5])[0]
            sku, part = FAULT_PART_MAP[fault_type]
            faults.append({
                "device_id": f"HIVE-{uuid.uuid4().hex[:8].upper()}",
                "property_postcode": rand_postcode(region),
                "region": region,
                "boiler_brand": brand,
                "boiler_model": random.choice(BOILER_MODELS.get(brand, ["Generic Model"])),
                "boiler_age_years": rnd(6, 18),
                "fault_type": fault_type,
                "required_sku": sku,
                "required_part": part,
                "fault_probability": rnd(0.70, 0.98, 4),
                "replacement_probability_90d": rnd(0.30, 0.85, 4),
                "signal_timestamp": (now - timedelta(hours=rnd(0.5, 6))).isoformat()},)
        return faults

    # Above this probability a signal is treated as a job that will happen, so the
    # part is pushed to the van ahead of the call. Below it we watch. 0.85 is the
    # same bar the Hive webhook applies on ingest.
    _PRE_POSITION_THRESHOLD = 0.85
    _OUTREACH_THRESHOLD = 0.70

    def get_fault_pipeline(self) -> list:
        """Fault signals joined to the parts and the people who can clear them.

        Pre-positioning used to be `random.random() > 0.15` — the module's headline
        decision had no relationship to whether the part existed anywhere in the
        network, so the page could show a fault "pre-positioned" against a SKU that
        was stocked out. It is now read off the live network: a signal is
        pre-positioned when the fault is likely enough to act on AND the part that
        fixes it is either already on a van in that region or free to pick at the
        NDC. Signals with no cover are exactly what a control tower exists to
        surface — a predicted job we currently cannot fix first time."""
        # get_snapshot(), not _snapshot: on a cold process the baseline is built
        # lazily, and reading the raw attribute returned an empty pipeline for the
        # first caller.
        s = self.get_snapshot()
        engineers = s.get("engineer_locations", []) or []
        inventory = s.get("inventory_positions", []) or []

        # Which SKUs a region could actually put on a job today, counting only the
        # SURPLUS each van carries above its own minimum. Stock at or below minimum
        # is committed to that van's existing workload — pulling it to cover a
        # predicted job does not create cover, it just moves the gap to another
        # engineer. Off-duty engineers' stock is locked in a van on a driveway and
        # does not count at all.
        van_cover: dict = {}
        for e in engineers:
            if e.get("job_status") == "off_duty":
                continue
            region = e.get("region")
            for item in e.get("van_stock_items", []) or []:
                spare = item.get("quantity", 0) - item.get("min_quantity", 0)
                if spare > 0:
                    key = (region, item.get("sku_code"))
                    van_cover[key] = van_cover.get(key, 0) + spare

        ndc_cover = {}
        for i in inventory:
            sku = i.get("sku_code")
            if sku:
                ndc_cover[sku] = ndc_cover.get(sku, 0) + i.get("quantity_available", 0)

        out = []
        for f in s.get("boiler_fault_pipeline", []) or []:
            # Signals ingested before this join existed (or from the crisis script)
            # may not carry a part — derive it from the fault type.
            sku = f.get("required_sku")
            part = f.get("required_part")
            if not sku:
                sku, part = FAULT_PART_MAP.get(f.get("fault_type"), (None, None))

            region = f.get("region")
            on_van = van_cover.get((region, sku), 0) if sku else 0
            at_ndc = ndc_cover.get(sku, 0) if sku else 0
            prob = f.get("fault_probability", 0)

            if on_van > 0:
                cover, cover_source = "on_van", f"{on_van} in {region} vans"
            elif at_ndc > 0:
                cover, cover_source = "at_ndc", f"{at_ndc} at NDC — needs a transfer"
            else:
                cover, cover_source = "none", "No stock in network"

            out.append({
                **f,
                "required_sku": sku,
                "required_part": part,
                "parts_cover": cover,
                "cover_detail": cover_source,
                "van_stock_in_region": on_van,
                "ndc_available": at_ndc,
                # The decision, and why. Pre-positioning a part we do not have is
                # not a decision, it is a promise we cannot keep.
                "pre_positioning_triggered": prob >= self._PRE_POSITION_THRESHOLD and cover != "none",
                "pre_positioning_blocked": prob >= self._PRE_POSITION_THRESHOLD and cover == "none",
                "proactive_outreach_queued": f.get("replacement_probability_90d", 0) >= self._OUTREACH_THRESHOLD,
            })
        # Worst first: the jobs we cannot cover are the ones that need a human.
        out.sort(key=lambda r: (r["parts_cover"] != "none", -r.get("fault_probability", 0)))
        return out

    def _gen_predictive_replacements(self) -> list:
        result = []
        for i in range(10):
            brand = random.choice(BOILER_BRANDS)
            result.append({
                "device_id": f"HIVE-{uuid.uuid4().hex[:8].upper()}",
                "property_postcode": rand_postcode(),
                "boiler_brand": brand,
                "boiler_age_years": rnd(12, 22),
                "replacement_probability_90d": rnd(0.85, 0.99, 4),
                "recommended_replacement_unit": f"{brand} Latest Model",
                "outreach_queued": True,
                "estimated_job_date": (date.today() + timedelta(days=random.randint(7, 60))).isoformat()},)
        return result

    def _gen_smart_meter_status(self, signals: dict | None = None) -> dict:
        """SMET2 rollout as the IoT module sees it.

        Installed-to-date and the target are the MHHS programme's own numbers, not
        a second invented pair. They used to be drawn independently here
        (33k–40k against MHHS's 31k–38k), so the IoT page and the Demand page
        reported different totals for the same real-world fact and whichever one
        you read last was the one you believed. Same source, same answer — the
        rule get_smart_meter_dashboard() already follows."""
        mhhs = (signals or {}).get("mhhs_schedule", {})
        total = mhhs.get("installed_ytd") or random.randint(31000, 38000)
        dcc_reg = round(total * rnd(0.96, 0.99))
        return {
            "installed_total": total,
            "dcc_registered": dcc_reg,
            "firmware_updated": round(dcc_reg * rnd(0.97, 0.99)),
            "commissioning_failures_7d": random.randint(12, 45),
            "install_rate_per_week": mhhs.get("install_rate_per_week"),
            "target_fy": mhhs.get("smart_meters_target_q3", 48000)}

    def _gen_van_telematics(self, engineers: list, fleet: list, now: datetime) -> list:
        """The connected-van half of the IoT estate.

        This used to be `engineers[:50]` — the engineer roster under a different
        name, carrying no telemetry at all, behind an endpoint nothing called. It
        now joins the engineer to the vehicle that is already modelled in
        fleet_vehicles and adds only what a telematics unit actually reports:
        whether the box is talking to us, when it last did, and the driving
        behaviour the fleet KPIs are scored on."""
        by_engineer = {v["engineer_code"]: v for v in fleet}
        out = []
        for e in engineers[:50]:
            veh = by_engineer.get(e["engineer_code"], {})
            # A unit that has not reported in over an hour is a blind spot: the van
            # is still working, we just cannot see it.
            mins_since_ping = random.choices([rnd(0, 8), rnd(8, 60), rnd(60, 480)],
                                             weights=[80, 14, 6])[0]
            moving = e.get("job_status") == "en_route"
            out.append({
                "engineer_code": e["engineer_code"],
                "engineer_name": e["name"],
                "registration": veh.get("registration"),
                "make_model": veh.get("make_model"),
                "fuel_type": veh.get("fuel_type"),
                "region": e.get("region"),
                "business_unit": e.get("business_unit"),
                "latitude": e.get("latitude"),
                "longitude": e.get("longitude"),
                "job_status": e.get("job_status"),
                "speed_mph": round(rnd(18, 62)) if moving else 0,
                "ignition_on": e.get("job_status") in ("en_route", "on_site"),
                "odometer_miles": veh.get("mileage"),
                "minutes_since_ping": round(mins_since_ping, 1),
                "telemetry_healthy": mins_since_ping <= 60,
                "harsh_braking_7d": random.randint(0, 9),
                "harsh_acceleration_7d": random.randint(0, 7),
                "speeding_events_7d": random.randint(0, 5),
                "idling_pct": rnd(3, 22),
                "van_stock_low": e.get("van_stock_low", False)},)
        return out

    def _drift_van_telematics(self, s: dict):
        """Re-ping the connected vans, keeping position and status in step with the
        engineer record they belong to. A unit that has gone quiet mostly stays
        quiet — comms blackspots and flat units do not clear themselves within a
        ping — so recovery is deliberately slower than failure."""
        by_code = {e["engineer_code"]: e for e in s.get("engineer_locations", [])}
        for t in s.get("van_telematics", []) or []:
            eng = by_code.get(t.get("engineer_code"))
            if eng:
                t["latitude"] = eng.get("latitude")
                t["longitude"] = eng.get("longitude")
                t["job_status"] = eng.get("job_status")
                t["van_stock_low"] = eng.get("van_stock_low", False)
                t["ignition_on"] = eng.get("job_status") in ("en_route", "on_site")
                t["speed_mph"] = round(rnd(18, 62)) if eng.get("job_status") == "en_route" else 0
            if t.get("telemetry_healthy", True):
                # A healthy unit reports on time unless it drops out this tick.
                t["minutes_since_ping"] = round(rnd(0, 8), 1) if random.random() > 0.02 else round(rnd(61, 180), 1)
            else:
                # A dark unit usually stays dark, and the gap keeps growing.
                t["minutes_since_ping"] = (round(rnd(0, 6), 1) if random.random() < 0.25
                                           else round(min(480, t.get("minutes_since_ping", 90) + rnd(0.5, 8)), 1))
            t["telemetry_healthy"] = t["minutes_since_ping"] <= 60

    def get_iot_estate_health(self) -> dict:
        """Is the estate we make these calls on actually reporting?

        A prediction pipeline is only worth what its inputs are worth, so the
        control tower needs the health of the sensing layer itself — the question
        every connected-asset platform puts on its front page. All of it is counted
        off the live snapshot rather than declared."""
        s = self.get_snapshot()
        faults = s.get("boiler_fault_pipeline", []) or []
        telematics = s.get("van_telematics", []) or []
        sm = s.get("smart_meter_status", {}) or {}
        pipeline = self.get_fault_pipeline()

        reporting = [t for t in telematics if t.get("telemetry_healthy")]
        actionable = [f for f in pipeline if f.get("fault_probability", 0) >= self._PRE_POSITION_THRESHOLD]
        covered = [f for f in actionable if f.get("parts_cover") != "none"]
        blocked = [f for f in pipeline if f.get("pre_positioning_blocked")]

        # Connected devices we are actually taking decisions from: the Hive boiler
        # estate plus the smart meters registered with the DCC plus the vans.
        connected = len(faults) + sm.get("dcc_registered", 0) + len(telematics)

        return {
            "connected_devices": connected,
            "boiler_signals_live": len(faults),
            "smart_meters_reporting": sm.get("dcc_registered", 0),
            "vans_reporting": len(reporting),
            "vans_total": len(telematics),
            "van_telemetry_health_pct": round(len(reporting) / len(telematics) * 100, 1) if telematics else None,
            # The number the whole module exists to move: of the faults we are
            # confident enough to act on, how many can we actually turn up and fix
            # first time, because the part is within reach?
            "parts_cover_pct": round(len(covered) / len(actionable) * 100, 1) if actionable else None,
            "actionable_signals": len(actionable),
            "pre_positioning_blocked": len(blocked),
            "commissioning_failures_7d": sm.get("commissioning_failures_7d", 0)}

    def reverse_collection_backlog(self) -> dict:
        """Units decommissioned but not yet collected, read off the reverse
        pipeline's stage counts. `reverse_pipeline` is a staged funnel (a dict),
        not a list of units — everything sitting at the job or the trade counter
        is still awaiting a collection leg."""
        pipe = self._snapshot.get("reverse_pipeline", {}) or {}
        stages = pipe.get("stages", []) if isinstance(pipe, dict) else []
        awaiting = {"Decommissioned at Job", "At Trade Counter"}
        pending = sum(st.get("count", 0) for st in stages if st.get("stage") in awaiting)
        weee = pipe.get("weee_compliant_pct", 100) if isinstance(pipe, dict) else 100
        return {"pending": pending, "weee_compliant_pct": weee,
                "at_risk": round(pending * max(0, (100 - weee)) / 100)}

    def _gen_reverse_pipeline(self) -> dict:
        return {
            "stages": [
                {"stage": "Decommissioned at Job", "count": random.randint(280, 350), "value_gbp": 0},
                {"stage": "At Trade Counter", "count": random.randint(180, 250), "value_gbp": 0},
                {"stage": "HTS Received", "count": random.randint(120, 180), "value_gbp": 0},
                {"stage": "In Reconditioning", "count": random.randint(80, 130), "value_gbp": 0},
                {"stage": "Reconditioned / Available", "count": random.randint(40, 90), "value_gbp": random.randint(18000, 45000)},
                {"stage": "Ramco Auction", "count": random.randint(20, 50), "value_gbp": random.randint(5000, 15000)},
            ],
            "weee_compliant_pct": rnd(97, 100),
            "coshh_compliant_pct": rnd(98, 100),
            "month": date.today().strftime("%Y-%m")}

    def _gen_sustainability_dashboard(self) -> dict:
        return {
            "landfill_diversion_pct": rnd(88, 94),
            "landfill_diversion_target": 95,
            "reconditioning_yield_pct": rnd(72, 82),
            "reconditioned_parts_in_use": random.randint(4200, 6800),
            "co2_saved_kg_ytd": random.randint(180000, 240000),
            "weee_compliance_pct": rnd(97, 100),
            "scope3_total_tco2e_ytd": rnd(1820, 2100),
            "scope3_target_tco2e_fy": 2000}

    def _gen_hts_batches(self) -> list:
        components = ["diverter_valve", "pcb_control_board", "fan_motor", "heat_exchanger", "pressure_relief_valve"]
        batches = []
        for i, comp in enumerate(components):
            submitted = random.randint(80, 300)
            recon = round(submitted * rnd(0.65, 0.82))
            batches.append({
                "batch_ref": f"HTS-2026-{100 + i:03d}",
                "component_type": comp,
                "units_submitted": submitted,
                "units_reconditioned": recon,
                "units_scrapped": submitted - recon,
                "yield_pct": round(recon / submitted * 100, 1),
                "bsi_kitemark_certified": random.random() > 0.2,
                "status": random.choice(["in_progress", "qc", "completed"]),
                "intake_date": (date.today() - timedelta(days=random.randint(14, 60))).isoformat()},)
        return batches

    def _gen_scope3_emissions(self) -> dict:
        categories = [
            ("inbound_freight_eu", rnd(180, 280)),
            ("inbound_freight_asia", rnd(320, 520)),
            ("domestic_courier", rnd(140, 220)),
            ("engineer_van_fleet", rnd(580, 820)),
            ("hgv_delivery", rnd(80, 140)),
        ]
        monthly = []
        for m in range(6):
            month_date = date.today().replace(day=1) - timedelta(days=30 * m)
            monthly.append({
                "month": month_date.strftime("%Y-%m"),
                "total_tco2e": round(sum(v for _, v in categories) * rnd(0.9, 1.1), 2)},)
        return {
            "by_category": [{"category": cat, "tco2e": val} for cat, val in categories],
            "monthly_trend": monthly,
            "total_ytd_tco2e": round(sum(v for _, v in categories) * 6 * rnd(0.85, 0.95), 2)}

    def _gen_circular_economy_kpis(self) -> dict:
        return {
            "landfill_diversion_pct": rnd(88, 94),
            "target_pct": 95,
            "reconditioned_parts_used": random.randint(4200, 6800),
            "reconditioned_value_gbp": random.randint(380000, 620000),
            "weee_compliant_pct": rnd(97, 100),
            "bsi_certified_batches": random.randint(8, 15),
            "co2_saved_vs_landfill_kg": random.randint(180000, 240000),
            "people_planet_plan_on_track": True}

    def _gen_executive_kpis(self) -> dict:
        return {
            "first_time_fix_rate": {"value": rnd(85, 92), "target": 82, "unit": "pct", "rag": "G", "trend": "up"},
            "expediting_cost_pct": {"value": rnd(1.2, 2.8), "target": 3.0, "unit": "pct", "rag": "G", "trend": "down"},
            "p1_response_time_min": {"value": rnd(2, 4), "target": 5, "unit": "minutes", "rag": "G", "trend": "stable"},
            "landfill_diversion_pct": {"value": rnd(95, 99), "target": 95, "unit": "pct", "rag": "G", "trend": "up"},
            "supplier_otif": {"value": rnd(93, 98), "target": 92, "unit": "pct", "rag": "G", "trend": "stable"},
            "scope3_ytd_tco2e": {"value": rnd(1600, 1950), "target": 2000, "unit": "tco2e", "rag": "G", "trend": "down"},
            "inventory_accuracy_pct": {"value": rnd(97, 99.5), "target": 98, "unit": "pct", "rag": "G", "trend": "up"},
            "cost_per_install_gbp": {"value": rnd(180, 220), "target": 210, "unit": "£", "rag": "G", "trend": "down"},
            "sla_breach_rate_pct": {"value": rnd(0.5, 2.0), "target": 3.0, "unit": "pct", "rag": "G", "trend": "down"}}

    def _gen_operational_kpis(self) -> dict:
        return {
            "pre_8am_delivery_success": {"value": rnd(96, 99), "target": 95, "unit": "pct", "rag": "G"},
            "in_boot_availability": {"value": rnd(92, 97), "target": 90, "unit": "pct", "rag": "G"},
            "van_fill_accuracy": {"value": rnd(93, 98), "target": 92, "unit": "pct", "rag": "G"},
            "forecast_accuracy_30d": {"value": rnd(88, 95), "target": 88, "unit": "pct", "rag": "G"},
            "locker_fill_rate": {"value": rnd(51, 65), "target": 50, "unit": "pct", "rag": "G"},
            "inter_engineer_transfers": {"value": random.randint(4, 12), "unit": "count/week"}}

    def _gen_procurement_kpis(self) -> dict:
        return {
            "supplier_otif_avg": {"value": rnd(93, 98), "target": 92, "unit": "pct"},
            "open_pos": random.randint(18, 35),
            "emergency_pos_pct": rnd(0.5, 1.8),
            "ariba_expiring_30d": random.randint(0, 2),
            "ariba_expired": 0,
            "sme_payment_on_time_pct": rnd(96, 99)}

    def _gen_sustainability_kpis(self) -> dict:
        return self._gen_circular_economy_kpis()

    def _gen_transport_kpis(self) -> dict:
        return {
            "fleet_utilization_pct": {"value": rnd(88, 94), "target": 90, "unit": "pct", "rag": "G", "trend": "up"},
            "on_time_delivery_pct": {"value": rnd(95, 98.5), "target": 95, "unit": "pct", "rag": "G", "trend": "stable"},
            "freight_spend_gbp": {"value": rnd(42000, 48000), "target": 45000, "unit": "£", "rag": "G", "trend": "stable"},
            "active_carriers": {"value": random.randint(12, 15), "target": 12, "unit": "count", "rag": "G", "trend": "stable"},
            "fuel_efficiency_mpg": {"value": rnd(35, 42), "target": 38, "unit": "mpg", "rag": "G", "trend": "up"},
            "transit_exceptions": {"value": random.randint(2, 8), "target": 10, "unit": "count", "rag": "G", "trend": "down"}}

    def _gen_field_dispatcher_kpis(self, engineers: list) -> dict:
        low_van_count = len([e for e in engineers if e.get("van_stock_low")])
        return {
            "active_engineers": len([e for e in engineers if e["job_status"] != "off_duty"]),
            "engineers_on_site": len([e for e in engineers if e["job_status"] == "on_site"]),
            "engineers_available": len([e for e in engineers if e["job_status"] == "available"]),
            "van_stock_low_count": low_van_count,
            "lockers_pre_loaded_today": random.randint(4100, 4500),
            "locker_gaps_count": random.randint(8, 18),
            "pending_transfers": random.randint(3, 12)}

    # Realistic baselines for a healthy network day. Absenteeism < 5% and
    # Turnover < 16% are our Green thresholds (UK logistics/warehousing norms).
    _LABOUR_BASELINES: dict[str, dict] = {
        "LEI_COE": {"abs": (2.8, 3.4), "trn": (11.0, 12.5), "agency": (4, 8),  "ot": (5, 9)},
        "COV_HUB": {"abs": (2.2, 2.7), "trn": (10.0, 11.5), "agency": (3, 6),  "ot": (4, 8)},
        "MAN_HUB": {"abs": (3.0, 3.8), "trn": (12.0, 13.5), "agency": (5, 9),  "ot": (6, 10)},
        "CAR_HUB": {"abs": (2.5, 3.1), "trn": (10.5, 12.0), "agency": (3, 7),  "ot": (4, 8)}}
    _LABOUR_BASELINE_DEFAULT = {"abs": (3.5, 4.5), "trn": (12.0, 15.0), "agency": (5, 10), "ot": (6, 11)}

    # Per-scenario labour-risk override ranges, keyed by warehouse code. Only
    # scenarios with a plausible workforce story are listed (a port-congestion
    # or supplier-insolvency event doesn't move headcount metrics); anything
    # absent for a given warehouse falls back to _LABOUR_BASELINES. Mirrors
    # SCENARIO_TICK_RANGES's shape so the same "redraw within a band every
    # cycle" pattern applies to labour as it does to warehouse throughput.
    _BALLOT_STAGES = {"none": 0, "notice_served": 8, "ballot_open": 16, "action_short_of_strike": 20, "strike_action": 24}

    SCENARIO_LABOUR_RANGES: dict[str, dict[str, dict]] = {
        "p1_3pl_closure": {
            "LEI_COE": {"abs": (16, 21), "trn": (25, 32), "agency": (35, 48), "ot": (1, 6),
                        "gmb": "active", "unite": "active", "news": (10, 18), "comms_normal": False,
                        "ballot_status": "strike_action"}},
        "courier_shortage": {
            "MAN_HUB": {"abs": (5, 7), "trn": (14, 17), "agency": (22, 32), "ot": (18, 26),
                        "gmb": "none", "unite": "watch", "news": (0, 1), "comms_normal": True,
                        "ballot_status": "none"}},
        "fuel_crisis": {
            wh: {"abs": (7, 10), "trn": (12, 14), "agency": (10, 16), "ot": (14, 20),
                 "gmb": "none", "unite": "none", "news": (0, 1), "comms_normal": True,
                 "ballot_status": "none"}
            for wh in ("LEI_COE", "COV_HUB", "MAN_HUB", "CAR_HUB")
        },
        "beast_from_east": {
            wh: {"abs": (8, 12), "trn": (13, 16), "agency": (12, 18), "ot": (20, 28),
                 "gmb": "none", "unite": "none", "news": (0, 1), "comms_normal": True,
                 "ballot_status": "none"}
            for wh in ("LEI_COE", "COV_HUB", "MAN_HUB", "CAR_HUB")
        },
        "cyber_incident": {
            "LEI_COE": {"abs": (5, 7), "trn": (13, 15), "agency": (8, 14), "ot": (22, 30),
                        "gmb": "none", "unite": "none", "news": (1, 3), "comms_normal": True,
                        "ballot_status": "none"}},
        "p2_stockout": {
            "LEI_COE": {"abs": (3.5, 4.5), "trn": (12, 13.5), "agency": (8, 12), "ot": (14, 20),
                        "gmb": "none", "unite": "none", "news": (0, 0), "comms_normal": True,
                        "ballot_status": "none"}},
        "heat_pump_surge": {
            "LEI_COE": {"abs": (3.2, 4.0), "trn": (11.5, 13), "agency": (10, 15), "ot": (16, 22),
                        "gmb": "none", "unite": "none", "news": (0, 0), "comms_normal": True,
                        "ballot_status": "none"}},}

    @classmethod
    def _compute_labour_risk_score(cls, abs_rate: float, trn_rate: float, agency_pct: float,
                                    overtime_pct: float, gmb: str, unite: str,
                                    news_count: int, comms_normal: bool, ballot_status: str) -> int:
        """Composite score from underlying workforce signals — mirrors how a real
        labour-risk index blends absence/attrition trend, contingent-labour
        dependency, overtime strain, union sentiment and industrial-action stage
        rather than reporting a single flat number."""
        raw = (
            abs_rate * 1.8
            + max(0.0, trn_rate - 10) * 1.1
            + agency_pct * 0.45
            + overtime_pct * 0.35
            + (10 if gmb != "none" else 0)
            + (10 if unite not in ("none",) else 0)
            + min(15, news_count * 1.2)
            + cls._BALLOT_STAGES.get(ballot_status, 0)
            + (0 if comms_normal else 8)
        )
        return max(1, min(100, round(raw)))

    def _draw_labour_assessment(self, wh: dict) -> dict:
        """Draw one warehouse's labour-risk snapshot: scenario-appropriate band
        if this scenario tells a workforce story for this site, else the
        healthy baseline band. Called on every generation, scenario apply and
        tick so the Labour Risk page stays live and scenario-consistent."""
        code = wh["code"]
        override = self.SCENARIO_LABOUR_RANGES.get(self._active_scenario or "", {}).get(code)
        base = self._LABOUR_BASELINES.get(code, self._LABOUR_BASELINE_DEFAULT)

        abs_rate = rnd(*override["abs"]) if override else rnd(*base["abs"])
        trn_rate = rnd(*override["trn"]) if override else rnd(*base["trn"])
        agency_pct = rnd(*override["agency"]) if override else rnd(*base["agency"])
        overtime_pct = rnd(*override["ot"]) if override else rnd(*base["ot"])
        gmb = override["gmb"] if override else "none"
        unite = override["unite"] if override else "none"
        news_count = random.randint(*override["news"]) if override else 0
        comms_normal = override["comms_normal"] if override else True
        ballot_status = override["ballot_status"] if override else "none"

        risk_score = self._compute_labour_risk_score(
            abs_rate, trn_rate, agency_pct, overtime_pct, gmb, unite, news_count, comms_normal, ballot_status)

        return {
            "warehouse_code": code,
            "warehouse_name": wh["name"],
            "risk_score": risk_score,
            "absenteeism_rate": round(abs_rate, 1),
            "turnover_rate": round(trn_rate, 1),
            "agency_staff_pct": round(agency_pct, 1),
            "overtime_pct": round(overtime_pct, 1),
            "gmb_activity_level": gmb,
            "unite_activity_level": unite,
            "news_signal_count": news_count,
            "management_comms_normal": comms_normal,
            "ballot_status": ballot_status,
            "safety_incidents_ytd": random.randint(2, 5) if override else random.randint(0, 2),
            "assessment_date": date.today().isoformat()}

    def _gen_labour_assessments(self) -> list:
        return [self._draw_labour_assessment(wh) for wh in WAREHOUSES_DATA]

    def _apply_labour_state(self):
        """Redraw labour_assessments for the active scenario (or baseline) and
        mirror the composite score onto warehouse_status.labour_risk_score so
        the Visibility Hub and the Risk page never disagree about the same
        warehouse's labour risk."""
        s = self._snapshot
        assessments = [self._draw_labour_assessment(wh) for wh in WAREHOUSES_DATA]
        s["labour_assessments"] = assessments
        by_code = {a["warehouse_code"]: a["risk_score"] for a in assessments}
        for wh in s.get("warehouse_status", []):
            if wh["code"] in by_code:
                wh["labour_risk_score"] = by_code[wh["code"]]

    # ─────────────────────────────────────────────
    # DERIVED-STATE SYNC
    # ─────────────────────────────────────────────
    # Analytics KPI families are DERIVED from core state so every page tells the
    # same story during scenarios and normal ticks. Research-grounded specials
    # per scenario (e.g. ransomware degrades stock accuracy; cold snaps wreck
    # forecast accuracy; port congestion forces 5-10x air-freight premiums).

    _SCENARIO_DERIVED: dict[str, dict] = {
        "p1_3pl_closure":    {"sla_breach_add": 6.0, "freight_mult": 1.35, "cost_install_add": 45},
        "p2_stockout":       {"sla_breach_add": 4.0, "freight_mult": 1.25, "cost_install_add": 30},
        "beast_from_east":   {"forecast_accuracy": 76.0, "scope3": 2280, "freight_mult": 1.30,
                              "fuel_mpg": 31.0, "cost_install_add": 25, "sla_breach_add": 3.0},
        "supplier_insolvency": {"cost_install_add": 38, "freight_mult": 1.15},
        "heat_pump_surge":   {"forecast_accuracy": 71.0, "freight_mult": 1.20, "cost_install_add": 20},
        "port_congestion":   {"scope3": 2140, "freight_mult": 1.45, "cost_install_add": 22,
                              "forecast_accuracy": 84.0},
        "cyber_incident":    {"inventory_accuracy": 84.3, "sla_breach_add": 5.0, "freight_mult": 1.15},
        "fuel_crisis":       {"fuel_mpg": 33.0, "freight_mult": 1.40, "sla_breach_add": 2.0},
        "locker_outage":     {},
        "courier_shortage":  {"freight_mult": 1.12, "sla_breach_add": 3.5},
        "supplier_otif_dip": {}}

    @staticmethod
    def _exec_entry(value, target, unit, lower_better=False):
        if lower_better:
            rag = "G" if value <= target else ("A" if value <= target * 1.35 else "R")
            trend = "down" if rag == "G" else "up"
        else:
            rag = "G" if value >= target else ("A" if value >= target * 0.92 else "R")
            trend = "stable" if rag == "G" else "down"
        return {"value": round(value, 1), "target": target, "unit": unit, "rag": rag, "trend": trend}

    def _sync_derived_state(self):
        """Recompute analytics KPI families + rollups from core state."""
        s = self._snapshot
        k = s.get("kpis", {})
        eff = dict(self._SCENARIO_DERIVED.get(self._active_scenario or "", {}))
        # A user-activated response plan's partial recovery applies regardless of
        # whether its scenario is still the simulator's "active" one — e.g. a
        # baseline-only exception (locker_outage, supplier_otif_dip) can be
        # activated with no simulator scenario applied at all.
        for _sid, _overrides in self._plan_effect_overrides.items():
            eff.update(_overrides)
        engineers = s.get("engineer_locations", [])
        fleet = s.get("fleet_vehicles", [])
        lockers = s.get("locker_status", [])
        shipments = s.get("shipments", [])
        pos = s.get("purchase_orders", [])
        suppliers = s.get("supplier_scorecards", [])
        open_exc = [e for e in s.get("exceptions", []) if e.get("status") == "open"]
        traffic = s.get("traffic_severity", "normal")

        def kv(key, default):
            return k.get(key, {}).get("value", default)

        ftfr = kv("first_time_fix_rate", 86)
        expediting = kv("expediting_cost_pct", 2.0)
        # Network OTIF is volume-weighted (Σ on-time ÷ Σ placed), matching how
        # a blended supplier scorecard is computed in practice — a flat average
        # across suppliers would let one low-volume chronic under-performer
        # (e.g. Samsung HA) permanently drag the network-wide figure down.
        total_placed = sum(sp["orders_placed"] for sp in suppliers)
        otif_avg = round(sum(sp["orders_on_time"] for sp in suppliers) / total_placed * 100, 1) if total_placed else 94.0

        # ── Executive KPIs (Executive Dashboard grid + Analytics) ──
        p1_open = len([e for e in open_exc if e["priority"] == "P1"])
        sla = min(24.0, rnd(0.6, 1.6) + p1_open * 3.0 + max(0, 82 - ftfr) * 0.4 + eff.get("sla_breach_add", 0))
        fin = self.get_financials()
        stock_val = fin.get("stock_value_gbp", 0) or 1
        s["executive_kpis"] = {
            "first_time_fix_rate": self._exec_entry(ftfr, 82, "pct"),
            "expediting_cost_pct": self._exec_entry(expediting, 3.0, "pct", lower_better=True),
            "p1_response_time_min": self._exec_entry(kv("p1_response_time_min", 3), 5, "minutes", lower_better=True),
            "landfill_diversion_pct": self._exec_entry(kv("landfill_diversion", 96), 95, "pct"),
            "supplier_otif": self._exec_entry(otif_avg, 92, "pct"),
            "scope3_ytd_tco2e": self._exec_entry(eff.get("scope3", kv("scope3_emissions_ytd", 1850)), 2000, "tco2e", lower_better=True),
            "inventory_accuracy_pct": self._exec_entry(eff.get("inventory_accuracy", rnd(97, 99.5)), 98, "pct"),
            "cost_per_install_gbp": self._exec_entry(rnd(185, 208) + eff.get("cost_install_add", 0), 210, "£", lower_better=True),
            "sla_breach_rate_pct": self._exec_entry(round(sla, 1), 3.0, "pct", lower_better=True),
            # ── Demand & Inventory financial lens, so the board-level view reflects
            # the same working-capital story the module now tells.
            #
            # Targets are benchmark-based and scale with the stockholding. A target
            # of zero for excess or value-at-risk would be permanently unachievable
            # (RAG is green only when value <= target), which would peg these red
            # for ever and drag the whole dashboard to CRITICAL on a normal day.
            "inventory_working_capital_gbp": self._exec_entry(stock_val, round(stock_val * 1.05), "£", lower_better=True),
            # 4–8 turns is typical for service-parts distribution
            "inventory_turns": self._exec_entry(fin.get("inventory_turns") or 0, 4.0, "x"),
            # Distributors target 2.0–3.5x, but slow-moving spares sit structurally lower
            "gmroi": self._exec_entry(fin.get("gmroi") or 0, 1.25, "x"),
            # Tolerance of ~2% of stock value; beyond that the buffer policy is failing
            "inventory_value_at_risk_gbp": self._exec_entry(fin.get("value_at_risk_gbp", 0), round(stock_val * 0.02), "£", lower_better=True),
            # Best-in-class holds excess below 5% of total stock value
            "excess_stock_gbp": self._exec_entry(fin.get("excess_value_gbp", 0), round(stock_val * 0.05), "£", lower_better=True)}

        # ── Operational KPIs (Analytics) ──
        van_low = len([e for e in engineers if e.get("van_stock_low")])
        van_low_pct = van_low / len(engineers) * 100 if engineers else 0
        lockers_alert = len([l for l in lockers if l.get("status") == "alert"])
        lockers_alert_pct = lockers_alert / len(lockers) * 100 if lockers else 0
        s["operational_kpis"] = {
            "pre_8am_delivery_success": self._exec_entry(kv("pre_8am_success_rate", 97), 95, "pct"),
            "in_boot_availability": self._exec_entry(kv("in_boot_availability", 94), 90, "pct"),
            "van_fill_accuracy": self._exec_entry(max(60.0, 96.5 - van_low_pct * 0.5), 92, "pct"),
            "forecast_accuracy_30d": self._exec_entry(eff.get("forecast_accuracy", rnd(88, 95)), 88, "pct"),
            "locker_fill_rate": self._exec_entry(max(30.0, rnd(51, 65) - lockers_alert_pct * 0.4), 50, "pct"),
            "inter_engineer_transfers": {"value": max(4, round(van_low / 12)), "unit": "count/week"}}

        # ── Procurement KPIs (Analytics) ──
        open_pos = [p for p in pos if p.get("status") in ("draft", "confirmed", "in_transit")]
        emergency = [p for p in open_pos if p.get("po_type") == "emergency"]
        s["procurement_kpis"] = {
            "supplier_otif_avg": {"value": otif_avg, "target": 92, "unit": "pct"},
            "open_pos": len(open_pos),
            "emergency_pos_pct": round(len(emergency) / len(open_pos) * 100, 1) if open_pos else 0.0,
            "ariba_expiring_30d": s.get("procurement_kpis", {}).get("ariba_expiring_30d", 1),
            "ariba_expired": s.get("procurement_kpis", {}).get("ariba_expired", 0),
            "sme_payment_on_time_pct": rnd(96, 99)}

        # ── Transport KPIs (Analytics) ──
        vor = len([v for v in fleet if v.get("vor")])
        util = (len(fleet) - vor) / len(fleet) * 100 * rnd(0.90, 0.96) if fleet else 90
        otd_penalty = {"normal": 0, "elevated": 2.5, "high": 5.5, "severe": 10.0}.get(traffic, 0)
        delayed_shipments = len([sh for sh in shipments if sh.get("status") == "delayed"])
        s["transport_kpis"] = {
            "fleet_utilization_pct": self._exec_entry(util, 90, "pct"),
            "on_time_delivery_pct": self._exec_entry(rnd(95.5, 98.5) - otd_penalty, 95, "pct"),
            "freight_spend_gbp": self._exec_entry(rnd(42000, 46000) * eff.get("freight_mult", 1.0), 45000, "£", lower_better=True),
            "active_carriers": {"value": random.randint(12, 15), "target": 12, "unit": "count", "rag": "G", "trend": "stable"},
            "fuel_efficiency_mpg": self._exec_entry(eff.get("fuel_mpg", rnd(36, 42)), 38, "mpg"),
            "transit_exceptions": self._exec_entry(delayed_shipments, 10, "count", lower_better=True)}

        # ── Labour risk — redrawn every sync so it stays live across ticks and
        # scenario-consistent (warehouse_status.labour_risk_score mirrors it) ──
        self._apply_labour_state()

        # ── Field dispatcher + rollups ──
        s["field_dispatcher_kpis"] = {
            **self._gen_field_dispatcher_kpis(engineers),
            "locker_gaps_count": lockers_alert,
            "pending_transfers": max(3, round(van_low / 8))}
        s["lockers_healthy_pct"] = round(100 - lockers_alert_pct, 1)

        # ── Sustainability rollup stays consistent with Scope 3 ──
        sust = s.get("sustainability_dashboard", {})
        sust["scope3_total_tco2e_ytd"] = s["executive_kpis"]["scope3_ytd_tco2e"]["value"]
        sust["landfill_diversion_pct"] = kv("landfill_diversion", 96)

        # Exposed so the Executive Dashboard AI panel can react to the scenario
        s["active_scenario"] = self._active_scenario

    # ─────────────────────────────────────────────
    # SCENARIO ENGINE
    # ─────────────────────────────────────────────

    # ── Cross-module impact helpers ──────────────────────────────────────────
    # A disruption is rarely confined to one module. Snow doesn't just lift boiler
    # demand — it slows every van, burns more fuel and costs engineers jobs. These
    # helpers let a scenario state its knock-on effects without each one
    # re-implementing the same mutations.


    def _impact_field(self, *, van_stock_low_pct: float = 0, off_duty_pct: float = 0) -> None:
        """Engineers who can't reach jobs or run their vans dry."""
        s = self._snapshot
        engineers = s.get("engineer_locations", [])
        if van_stock_low_pct:
            target = int(len(engineers) * van_stock_low_pct / 100.0)
            for eng in engineers:
                if target <= 0:
                    break
                if eng.get("van_stock_low"):
                    continue
                # Actually drain a line rather than only setting the flag. The
                # alert queue is derived from the item quantities, so a flag on
                # its own is erased by the next refresh and — worse — produces an
                # alert with no shortfall to resolve.
                items = eng.get("van_stock_items") or []
                if not items:
                    continue
                it = max(items, key=lambda i: i.get("min_quantity") or 0)
                it["quantity"] = max(0, (it.get("min_quantity") or 1) - 1)
                it["is_below_min"] = (it["quantity"] or 0) < (it.get("min_quantity") or 0)
                if not it["is_below_min"]:
                    continue          # this line has no minimum to breach
                eng["van_stock_low"] = True
                target -= 1
        if off_duty_pct:
            target = int(len(engineers) * off_duty_pct / 100.0)
            for eng in engineers:
                if target <= 0:
                    break
                if eng.get("job_status") != "off_duty":
                    eng["job_status"] = "off_duty"
                    target -= 1
            s["active_engineer_count"] = len([e for e in engineers if e.get("job_status") != "off_duty"])

    def _impact_carriers(self, *, delayed_pct: float = 0, delay_mins: tuple = (30, 180),
                         services: tuple | None = None, dest_types: tuple | None = None) -> None:
        """Push third-party legs late. A disruption that slows the roads or takes
        a hub out does not stop at our own vans — the carriers running hub →
        locker / in-boot / job-site legs slip with it, and those slips are what
        strand a bulky install or an engineer's morning collection."""
        movements = [
            m for m in self._snapshot.get("carrier_movements", [])
            if m.get("status") != "delivered"
            and (services is None or m.get("service") in services)
            and (dest_types is None or m.get("dest_type") in dest_types)]
        target = int(len(movements) * delayed_pct / 100.0)
        for mv in movements[:target]:
            mv["delay_mins"] = max(mv.get("delay_mins") or 0, random.randint(*delay_mins))
            mv["eta"] = (datetime.fromisoformat(mv["promised_at"])
                         + timedelta(minutes=mv["delay_mins"])).isoformat()
            mv["status"] = "delayed"
            mv["sla_at_risk"] = True
            mv.setdefault("milestones", []).append({
                "at": datetime.now(timezone.utc).isoformat(),
                "event": "Delay reported by carrier", "location": f"{mv['carrier']} control tower",
                "key": "delayed"})

    def _impact_routes(self, *, late_pct: float = 0, delay_mins: tuple = (15, 60),
                       cause: str = "traffic") -> None:
        """Put a share of live rounds behind schedule. The arrival-risk queue is
        derived from this, so a scenario that slows the network produces real
        at-risk appointments rather than an abstract KPI move."""
        routes = [r for r in (self._snapshot.get("engineer_routes") or {}).values()
                  if (r.get("stops_total") or 0) > (r.get("stops_completed") or 0)]
        target = int(len(routes) * late_pct / 100.0)
        for r in routes[:target]:
            r["delay_mins"] = max(r.get("delay_mins") or 0, random.randint(*delay_mins))
            r["delay_cause"] = cause

    def _refresh_resolution_layer(self) -> None:
        """Re-derive the three alert families from whatever state now says."""
        self.refresh_van_stock_alerts()
        self.refresh_locker_misses()
        self.refresh_route_eta_risk()

    def _impact_inventory(self, *, categories: list | None = None, on_hand_pct: float = 0,
                          max_skus: int | None = None) -> None:
        """Deplete (or restore) stock across a slice of the catalogue, then let the
        planning engine recompute cover, RAG and replenishment from the new position."""
        s = self._snapshot
        items = s.get("inventory_positions", [])
        if categories:
            items = [i for i in items if i.get("category") in categories]
        items = sorted(items, key=lambda i: -(i.get("quantity_on_hand") or 0))
        if max_skus:
            items = items[:max_skus]
        f = 1 + on_hand_pct / 100.0
        for it in items:
            it["quantity_on_hand"] = max(0, round((it.get("quantity_on_hand") or 0) * f))
        self._recompute_inventory_dos()

    def apply_scenario(self, scenario_id: str, ai_mode: bool | None = None) -> dict:
        """Mutate the in-memory snapshot to reflect a demo scenario across all modules.

        Every scenario has two variations, chosen by `ai_mode` (falling back to the
        engine's current master switch):

          AI OFF — the raw disruption. Exactly the original mechanism: the
                   scenario's impact lands across every module and stays there
                   until a human works it.
          AI ON  — the same disruption, then ATLAS's autonomous response applied
                   on top: ~80% of the actions the disruption demands are executed
                   inside their guardrails, the network is recovered to a healthy
                   state, and only the high-stakes remainder is left as pending
                   human approvals — each carrying its full reasoning trace.
        """
        if not self._initialized:
            self.initialize()
        if ai_mode is not None:
            self._ai_mode = bool(ai_mode)

        if scenario_id == "normal":
            self._active_scenario = None
            self._initialized = False
            self._plan_effect_overrides = {}
            self.initialize()
            self._new_world()   # the baseline is a fresh world — decisions about the old one lapse
            if self._ai_mode:
                self._apply_ai_autonomous_response("normal")
            else:
                self._snapshot["ai_response"] = self._ai_response_off("normal")
            self._sync_derived_state()
            return {"scenario": "normal", "ai_mode": self._ai_mode,
                    "message": "State reset to baseline",
                    "ai_response": self._snapshot.get("ai_response", {}).get("summary")}

        handler = {
            "p1_3pl_closure":      self._scenario_p1_3pl_closure,
            "p2_stockout":         self._scenario_p2_stockout,
            "beast_from_east":     self._scenario_beast_from_east,
            "supplier_insolvency": self._scenario_supplier_insolvency,
            "heat_pump_surge":     self._scenario_heat_pump_surge,
            "port_congestion":     self._scenario_port_congestion,
            "cyber_incident":      self._scenario_cyber_incident,
            "fuel_crisis":         self._scenario_fuel_crisis,
            "locker_outage":       self._scenario_locker_outage,
            "courier_shortage":    self._scenario_courier_shortage,
            "supplier_otif_dip":   self._scenario_supplier_otif_dip,
        }.get(scenario_id)

        if not handler:
            return {"error": f"Unknown scenario: {scenario_id}"}

        # Each scenario describes a single situation — apply it against a clean
        # baseline so switching scenarios never stacks mutations from the last one.
        self._active_scenario = None
        self._initialized = False
        self._plan_effect_overrides = {}
        self.initialize()
        self._new_world()   # this scenario replaces the world the last decisions were taken in

        handler()
        # Transport Control impact — traffic severity + fleet effects per scenario
        self._apply_transport_impact(**{
            "port_congestion":     {"traffic": "elevated"},
            "cyber_incident":      {"traffic": "elevated", "walkaround_missing_add": 40},
            "fuel_crisis":         {"traffic": "high", "vor_add": 14, "walkaround_missing_add": 12,
                                    "defect_desc": "Unable to refuel — awaiting depot fuel allocation",
                                    "travel_mins_pct": 16},
            "p1_3pl_closure":      {"traffic": "high", "travel_mins_pct": 12},
            "p2_stockout":         {"traffic": "elevated"},
            "beast_from_east":     {"traffic": "severe", "vor_add": 8, "walkaround_missing_add": 15,
                                    "defect_desc": "Weather damage — frozen door seals / battery failure",
                                    "ev_charge_penalty": 25,
                                    # Snow slows every van, burns diesel and drops OTIF
                                    "travel_mins_pct": 38},
            "supplier_insolvency": {},
            "heat_pump_surge":     {"traffic": "elevated"},
            "locker_outage":       {},
            "courier_shortage":    {"traffic": "elevated"},
            "supplier_otif_dip":   {},
        }.get(scenario_id, {}))
        # Third-party carrier legs and engineer arrival times move with the same
        # disruption — a closed hub cannot despatch, snow slows every carrier and
        # every van, a courier no-show strands the overnight wave.
        self._impact_carriers(**{
            "p1_3pl_closure":      {"delayed_pct": 70, "delay_mins": (120, 480)},
            "beast_from_east":     {"delayed_pct": 60, "delay_mins": (90, 360)},
            "fuel_crisis":         {"delayed_pct": 45, "delay_mins": (60, 240)},
            "courier_shortage":    {"delayed_pct": 55, "delay_mins": (90, 300),
                                    "services": ("pre_8am", "in_boot")},
            "locker_outage":       {"delayed_pct": 40, "delay_mins": (45, 180),
                                    "dest_types": ("locker",)},
            "cyber_incident":      {"delayed_pct": 50, "delay_mins": (90, 300)},
            "port_congestion":     {"delayed_pct": 25, "delay_mins": (60, 200)},
            "heat_pump_surge":     {"delayed_pct": 30, "delay_mins": (60, 240),
                                    "services": ("two_man",)},
        }.get(scenario_id, {"delayed_pct": 0}))
        self._impact_routes(**{
            "beast_from_east":     {"late_pct": 55, "delay_mins": (30, 110), "cause": "traffic"},
            "fuel_crisis":         {"late_pct": 40, "delay_mins": (20, 75), "cause": "traffic"},
            "p1_3pl_closure":      {"late_pct": 35, "delay_mins": (20, 80), "cause": "late_start"},
            "courier_shortage":    {"late_pct": 30, "delay_mins": (20, 70), "cause": "late_start"},
            "locker_outage":       {"late_pct": 28, "delay_mins": (15, 55), "cause": "parts_collection"},
            "cyber_incident":      {"late_pct": 32, "delay_mins": (20, 70), "cause": "late_start"},
            "port_congestion":     {"late_pct": 15, "delay_mins": (15, 45), "cause": "traffic"},
        }.get(scenario_id, {"late_pct": 0}))
        self._active_scenario = scenario_id  # prevent tick() from overwriting scenario values
        # Recompute all inventory derived fields from on_hand + current demand uplift
        self._recompute_inventory_dos()
        # Emergency/standard PO raising for SKUs the scenario pushed into critical
        # or amber now runs through ATLAS's own governed cycle (agent_engine.
        # run_autonomous_cycle, ticked from main.py) rather than an unconditional
        # bypass here — it picks the newly-critical positions up on its next
        # heartbeat, same as any other tick-driven change.
        # DRP auto-rebalancing: trunker transfers for hubs the scenario pushed critical
        self.auto_rebalance_hub_transfers()
        # Re-derive the operator-facing alert queues from the disrupted state
        self._refresh_resolution_layer()
        # Propagate the scenario into every derived analytics surface
        self._sync_derived_state()
        # ── The second variation of this state ────────────────────────────────
        # Everything above is the AI-OFF picture: the disruption, untouched. With
        # the master switch on, ATLAS's autonomous response runs on top of it and
        # rewrites the same modules to the recovered position.
        if self._ai_mode:
            self._apply_ai_autonomous_response(scenario_id)
        else:
            self._snapshot["ai_response"] = self._ai_response_off(scenario_id)
        # Re-derive summary counters after mutations
        self._snapshot["exceptions_summary"] = self._gen_exceptions_summary(
            self._snapshot.get("exceptions", [])
        )
        self._snapshot["last_refresh"] = datetime.now(timezone.utc).isoformat()
        return {"scenario": scenario_id, "ai_mode": self._ai_mode, "message": "Scenario applied",
                "ai_response": self._snapshot.get("ai_response", {}).get("summary")}

    # ═════════════════════════════════════════════════════════════════════════
    # AI-ON VARIATION — ATLAS's autonomous response layered over any state
    # ═════════════════════════════════════════════════════════════════════════

    # How healthy the network is, on the definition the Simulator publishes:
    #   Healthy  — no open P1/P2, throughput ≥ 85% of baseline, OTIF ≥ 92%,
    #              nothing stocked out without cover in flight
    #   At Risk  — amber KPIs, open P2/P3, throughput 60–84%
    #   Critical — open P1, an uncovered stockout, or the network below 60%
    #
    # Throughput is read NETWORK-wide (volume-weighted), not worst-site: a failover
    # deliberately sacrifices one site to keep the network serving, and grading on
    # the sacrificed site would score a successful failover as a failure.
    #
    # A stockout only counts when it is UNCOVERED. A zero position with a PO or
    # transfer already inbound is a timing problem, not a service failure.
    def health_state(self) -> dict:
        s = self._snapshot
        open_exc = [e for e in s.get("exceptions", []) if e.get("status") == "open"]
        p1 = sum(1 for e in open_exc if e.get("priority") == "P1")
        p2 = sum(1 for e in open_exc if e.get("priority") == "P2")

        whs = s.get("warehouse_status", [])
        num = sum((w.get("throughput_vs_baseline_pct") or 0) * (w.get("baseline_items_per_hour") or 1) for w in whs)
        den = sum((w.get("baseline_items_per_hour") or 1) for w in whs)
        net_thr = round(num / den, 1) if den else 100.0
        worst = round(min([w.get("throughput_vs_baseline_pct", 100) for w in whs] or [100]), 1)

        inv = s.get("inventory_positions", [])
        inbound = {p.get("sku_code") for p in s.get("purchase_orders", [])
                   if p.get("status") in ("draft", "confirmed", "in_transit")}
        inbound |= {t.get("sku_code") for t in s.get("transfer_orders", [])
                    if t.get("status") in ("draft", "requested", "approved", "in_transit")}
        uncovered = sum(1 for i in inv
                        if (i.get("quantity_available") or 0) <= 0 and i["sku_code"] not in inbound)
        reds = sum(1 for i in inv if i.get("rag_status") == "R")
        red_pct = round(reds / len(inv) * 100, 1) if inv else 0.0

        # Grade on the executive KPIs the dashboard shows — but only the SERVICE
        # ones. The balance-sheet family (working capital, turns, GMROI, value at
        # risk, excess) measures how much stock is tied up, not whether the network
        # is serving. A demand shock legitimately puts millions "at risk" for weeks
        # while service is fully restored, and grading network health on GMROI
        # would report a recovered network as a failing one.
        exec_kpis = s.get("executive_kpis", {}) or {}
        service = {"first_time_fix_rate", "expediting_cost_pct", "p1_response_time_min",
                   "supplier_otif", "sla_breach_rate_pct", "inventory_accuracy_pct",
                   "landfill_diversion_pct", "scope3_ytd_tco2e"}
        svc = {k: v for k, v in exec_kpis.items() if k in service and isinstance(v, dict)}
        kpi_red = sum(1 for v in svc.values() if v.get("rag") == "R")
        kpi_amber = sum(1 for v in svc.values() if v.get("rag") == "A")
        balance_red = sum(1 for k, v in exec_kpis.items()
                          if k not in service and isinstance(v, dict) and v.get("rag") == "R")
        otif = (exec_kpis.get("supplier_otif", {}) or {}).get("value", 94)

        # `uncovered` is reported but deliberately NOT graded. A 1,200-SKU
        # catalogue carries a permanent dead tail — the untouched baseline has ~17
        # positions at zero — so treating any stockout as a health signal would
        # mean the baseline could never be healthy, which contradicts the app's
        # own definition of it. Materiality is captured by the service KPIs.
        if p1 or net_thr < 60 or kpi_red >= 2:
            label = "critical"
        elif p2 or open_exc or net_thr < 85 or kpi_red >= 1 or kpi_amber >= 4:
            label = "at_risk"
        else:
            label = "healthy"
        return {"state": label, "open_p1": p1, "open_p2": p2, "open_exceptions": len(open_exc),
                "network_throughput_pct": net_thr, "lowest_throughput_pct": worst,
                "red_skus": reds, "red_sku_pct": red_pct, "uncovered_stockouts": uncovered,
                "supplier_otif": otif, "kpis_red": kpi_red, "kpis_amber": kpi_amber,
                "balance_sheet_red": balance_red,
                "residuals": [{"kpi": k, "value": v.get("value"), "target": v.get("target"), "rag": v.get("rag")}
                              for k, v in svc.items() if v.get("rag") in ("R", "A")]}

    def _ai_response_off(self, scenario_id: str) -> dict:
        """The AI-OFF half of the pair. Nothing is executed; the block still
        reports what ATLAS *would* have handled, so the operator can see exactly
        what turning the switch on would buy them."""
        health = self.health_state()
        candidates = self._ai_action_demand()
        auto = [c for c in candidates if ACTION_THRESHOLDS.get(c["threshold_key"], {}).get("autonomy") == "auto"]
        return {
            "enabled": False, "scenario_id": scenario_id, "generated_at": datetime.now(timezone.utc).isoformat(),
            "summary": {
                "mode": "off", "total_actions": len(candidates), "autonomous": 0,
                "human_required": len(candidates), "autonomy_pct": 0,
                "would_automate": len(auto),
                "would_automate_pct": round(len(auto) / len(candidates) * 100) if candidates else 0,
                "health_before": health["state"], "health_after": health["state"],
            },
            "health_before": health, "health_after": health,
            "actions": [], "pending": candidates,
            "narrative": (
                f"ATLAS is off. The {len(candidates)} action(s) this state demands are all sitting with a "
                f"human — including the {len(auto)} routine ones that are inside the guardrails the "
                f"business has already signed off."),
        }

    def _ai_action_demand(self) -> list[dict]:
        """Everything the CURRENT state demands be done, read straight off the
        snapshot. This is the work queue a disruption creates — the same queue
        whether or not ATLAS is the one working it."""
        s = self._snapshot
        out: list[dict] = []

        def want(threshold_key, agent, subject, title, detail, *, severity="medium",
                 confidence=80, value_gbp=0, **extra):
            cfg = ACTION_THRESHOLDS.get(threshold_key, {})
            out.append({
                "threshold_key": threshold_key, "action_key": cfg.get("action_key"),
                "label": cfg.get("label", threshold_key), "agent": agent, "subject": subject,
                "title": title, "detail": detail, "severity": severity, "confidence": confidence,
                "value_gbp": value_gbp, "module": cfg.get("module"), "module_label": cfg.get("module_label"),
                "tab": cfg.get("tab"), "policy_autonomy": "dual" if cfg.get("dual_control")
                else cfg.get("autonomy", "human"), **extra})

        # ── Exceptions · every open one demands ownership, and the ones with a
        # staged playbook demand a decision on activating it.
        for exc in [e for e in s.get("exceptions", []) if e.get("status") == "open"]:
            pr = exc.get("priority", "P3")
            sev = {"P1": "critical", "P2": "high", "P3": "medium"}.get(pr, "low")
            want("acknowledge", "exception", exc["exception_code"],
                 f"Acknowledge & own {exc['exception_code']}",
                 f"{pr} · {exc.get('title', '')} — unowned, resolution clock not started.",
                 severity=sev, confidence=88)
            # Only P1/P2 playbooks are worth a human's decision. A P3's plan fires
            # compensating actions that are individually inside the guardrails and
            # have already been executed — escalating it too would be asking for
            # approval of work that is done.
            if exc.get("scenario_id") and pr in ("P1", "P2"):
                want("activate_plan", "exception", exc["exception_code"],
                     f"Activate response plan for {exc['exception_code']}",
                     f"{pr} · a researched playbook is staged and waiting on a decision.",
                     severity=sev, confidence=86)

        # ── Inventory · reds need emergency cover, ambers need routine cover.
        inv = s.get("inventory_positions", [])
        open_po_skus = {p.get("sku_code") for p in s.get("purchase_orders", [])
                        if p.get("status") in ("draft", "confirmed", "in_transit")}
        # Two genuinely different answers to the same shortage, governed differently.
        # Moving stock the business already owns is reversible and bounded, so ATLAS
        # may do it — and it does it as ONE rebalancing run across every short
        # position, which is how DRP actually works. BUYING stock at premium freight
        # commits unplanned spend, so each of those is escalated on its own merits.
        short = [i for i in inv if i.get("rag_status") == "R" and i["sku_code"] not in open_po_skus]
        covered_by_transfer: set[str] = set()
        if short:
            # Size the run to the guardrail rather than proposing something that
            # will simply be refused: worst cover first, accumulate until the
            # transfer ceiling is reached. Whatever does not fit is exactly what
            # ends up in front of a human as a buying decision.
            ceiling = ACTION_THRESHOLDS.get("raise_transfer", {}).get("value_ceiling_gbp", 75000)
            # You can only move what exists. A position that still holds stock is
            # short at THIS site and can be topped up from surplus elsewhere; a
            # position at zero network-wide has nothing to move and can only be
            # bought — which is a human decision, not a transfer.
            ranked = sorted([i for i in short if (i.get("quantity_available") or 0) > 0],
                            key=lambda i: ((i.get("days_of_supply") or 0),
                                           -((i.get("safety_stock_level") or 0) * (i.get("unit_cost_gbp") or 50))))
            top_ups, running = [], 0
            for i in ranked:
                q = max(1, round(((i.get("safety_stock_level") or 0) - (i.get("quantity_available") or 0)) * 0.6))
                line = round(q * (i.get("unit_cost_gbp") or 50))
                if running + line > ceiling:
                    continue
                top_ups.append((i, q))
                running += line
            if top_ups:
                covered_by_transfer = {i["sku_code"] for i, _ in top_ups}
                want("raise_transfer", "replenishment", "network_cover",
                     f"Cover {len(top_ups)} short positions from network stock",
                     f"{len(top_ups)} of {len(short)} position(s) below safety stock can be covered from "
                     f"surplus held elsewhere — one rebalancing run moves what we already own, at "
                     f"£{running:,} of stock value and no new spend, before anything is bought.",
                     severity="high", confidence=83, value_gbp=running,
                     count=len(top_ups), batch=sorted(covered_by_transfer))
        # Only the positions the network could NOT cover need buying. Escalating an
        # emergency PO for a SKU another site is already sending would be paying a
        # freight premium for stock that is on its way.
        uncoverable = sorted([i for i in short if i["sku_code"] not in covered_by_transfer],
                             key=lambda i: -((i.get("target_order_qty") or 0) * (i.get("unit_cost_gbp") or 50)))
        # Escalate the ones that carry real value at risk. The long tail below them
        # is genuinely low-value dead stock that the weekly planning cycle clears —
        # putting it in front of a duty manager would bury the decisions that matter.
        for it in uncoverable[:4]:
            qty = max(it.get("target_order_qty") or 0, it.get("safety_stock_level") or 0)
            tail = max(0, len(uncoverable) - 4)
            want("raise_po_emergency", "replenishment", it["sku_code"],
                 f"Emergency PO — {it.get('description', it['sku_code'])}",
                 f"{it.get('days_of_supply', 0):g}d cover, nothing to move and nothing in flight. Premium "
                 f"freight to restart supply."
                 + (f" ({tail} lower-value tail position(s) left to the weekly cycle.)" if tail else ""),
                 severity="critical", confidence=94,
                 value_gbp=round(qty * (it.get("unit_cost_gbp") or 50)), sku_code=it["sku_code"], quantity=qty)
        for it in [i for i in inv if i.get("rag_status") == "A" and i["sku_code"] not in open_po_skus][:10]:
            qty = max(it.get("target_order_qty") or 0, it.get("safety_stock_level") or 0)
            want("raise_po_standard", "replenishment", it["sku_code"],
                 f"Replenish {it.get('description', it['sku_code'])}",
                 f"{it.get('days_of_supply', 0):g}d cover against a {it.get('lead_time_days', 2)}d lead — "
                 f"inside the reorder window.", severity="medium", confidence=82,
                 value_gbp=round(qty * (it.get("unit_cost_gbp") or 50)), sku_code=it["sku_code"], quantity=qty)
        for it in [i for i in inv if i.get("rag_status") == "R" and i["sku_code"] in open_po_skus][:3]:
            want("expedite_po", "replenishment", it["sku_code"],
                 f"Expedite the inbound covering {it['sku_code']}",
                 "Critical cover with replenishment already in flight — pull the delivery forward.",
                 severity="high", confidence=84, value_gbp=0, sku_code=it["sku_code"])

        # ── Fleet · defects strand engineers, missing walkarounds are a DVSA risk.
        fleet = s.get("fleet_vehicles", [])
        for v in [x for x in fleet if x.get("vor")][:8]:
            want("resolve_defect", "transport", v["registration"],
                 f"Clear defect on {v['registration']}",
                 f"{v.get('engineer_name', 'Engineer')} in {v.get('region', '—')} loses the round while it is off road.",
                 severity="high", confidence=79, registration=v["registration"])
        missing = [v for v in fleet if not v.get("walkaround_completed") and not v.get("vor")]
        if missing:
            want("walkaround_reminder", "transport", "walkaround",
                 f"Chase {len(missing)} missing DVSA walkarounds",
                 "Driving without a compliant walkaround is a DVSA enforcement risk.",
                 severity="medium", confidence=90, count=len(missing))

        # ── The four operational alert queues ────────────────────────────────
        # ATLAS works these exactly as an operator would: for each open alert it
        # takes the action the option engine RECOMMENDS for that alert in its
        # current state — the same recommendation shown on the operator's card.
        # Governance is then a separate question, answered below by the action
        # catalogue: `auto` self-executes inside its guardrails, anything else
        # goes to the approval queue with its reasoning.
        #
        # Deriving ATLAS's choice from the same engine that advises the human is
        # the whole point. Computed separately they drifted, and drifted badly:
        # the card would recommend re-booking a late consignment with the standby
        # carrier while ATLAS quietly filed an SLA claim — a commercial record
        # that recovers not one minute — because that happened to be the cheapest
        # thing on its own hand-written list.
        for r in self.recommended_resolutions():
            want(r["threshold_key"], r["agent"], r["subject"], r["title"], r["detail"],
                 severity=r["severity"], confidence=r["confidence"], value_gbp=r["cost_gbp"],
                 resolution_kind=r["kind"], resolution_action=r["action"],
                 subject_label=r["subject_label"], engine_recommended=r["recommended"])

        # ── Network · dead lockers and late inbound both cost engineers their day.
        no_pre8 = [l for l in s.get("locker_status", [])
                   if l.get("status") == "alert" and not l.get("pre_8am_delivered")]
        if len(no_pre8) >= 3:
            want("locker_failover", "visibility", "lockers",
                 f"Fail {len(no_pre8)} lockers over to healthy sites",
                 "Engineers will arrive to unconfirmed stock unless collections are re-pointed.",
                 severity="high" if len(no_pre8) >= 10 else "medium", confidence=81, count=len(no_pre8))
        # ── Suppliers · a flag is a contingency question, drift is a watch-list one.
        for sc in s.get("supplier_scorecards", []):
            otif, code = sc.get("otif_score"), sc.get("supplier_code")
            if sc.get("financial_health_flag"):
                want("supplier_review", "supplier", code,
                     f"Open contingency review — {sc.get('name', code)}",
                     "Financial-health flag raised. New commitments should be frozen pending review.",
                     severity="critical", confidence=88, supplier_code=code)
            elif otif is not None and otif < 80:
                want("otif_watchlist", "supplier", code,
                     f"Watch-list {sc.get('name', code)} at {otif:g}% OTIF",
                     "Below the 80% review trigger — weekly reporting until it recovers.",
                     severity="high" if otif < 65 else "medium", confidence=84, supplier_code=code)

        # ── Demand sensing · weather and IoT ask for stock and outreach up front.
        w = (s.get("demand_signals", {}) or {}).get("weather", {}) or {}
        hive = (s.get("demand_signals", {}) or {}).get("hive_faults", {}) or {}
        if (w.get("heating_degree_days_7d") or 0) >= 90 or (w.get("demand_uplift_factor") or 1) >= 1.35:
            want("pre_position", "demand_sensing", "weather_surge",
                 "Pre-position boiler parts ahead of the cold snap",
                 f"HDD {w.get('heating_degree_days_7d', 0):g}, uplift ×{w.get('demand_uplift_factor', 1):g} — "
                 f"cover that looks adequate today will not be in seven days.",
                 severity="high", confidence=80, value_gbp=30000)
        if (hive.get("high_probability_signals_24h") or 0) >= 4000:
            want("proactive_outreach", "demand_sensing", "outreach",
                 "Queue proactive outreach on high-risk boilers",
                 f"{hive.get('high_probability_signals_24h', 0):,} high-probability fault signals in 24h — "
                 f"turn breakdowns into planned first-time-fix visits.",
                 severity="medium", confidence=77)

        # ── Reverse logistics · backlog is both a WEEE and a Scope 3 problem.
        rev = self.reverse_collection_backlog()
        if rev["pending"] >= 8:
            want("collection_sweep", "sustainability", "reverse",
                 f"Sweep {rev['pending']} units awaiting collection",
                 f"Ageing units risk WEEE non-compliance ({rev['weee_compliant_pct']:g}% compliant) "
                 f"and tie up boot space.",
                 severity="medium", confidence=76, count=rev["pending"])

        # ── Working capital · excess is an opportunity, not a fire.
        excess = sorted([i for i in inv if i.get("rag_status") == "G" and (i.get("days_of_supply") or 0) > 120],
                        key=lambda i: -((i.get("quantity_available") or 0) * (i.get("unit_cost_gbp") or 50)))
        for it in excess[:2]:
            trapped = round((it.get("quantity_available") or 0) * (it.get("unit_cost_gbp") or 50))
            if trapped >= 5000:
                want("create_disposition", "replenishment", it["sku_code"],
                     f"Release £{trapped:,} trapped in {it['sku_code']}",
                     f"{it.get('days_of_supply'):g}d of cover — beyond policy.",
                     severity="opportunity", confidence=74, value_gbp=0, sku_code=it["sku_code"])
        return out

    def _ai_trace(self, cand: dict, *, executed: bool) -> dict:
        """The stack behind one AI action: what was sensed, how it was reasoned,
        who was consulted, how the disagreement was settled and why the decision
        went the way it did."""
        from app.services import reasoning as R
        cfg = ACTION_THRESHOLDS.get(cand["threshold_key"], {})
        ctx = R.build_context(self._snapshot, value_gbp=cand.get("value_gbp", 0),
                              severity=cand["severity"], confidence=cand["confidence"],
                              supplier_code=cand.get("supplier_code"), sku_code=cand.get("sku_code"))
        health = self.health_state()
        signals = [
            {"label": "Open exceptions", "value": health["open_exceptions"], "source": "exceptions"},
            {"label": "Open P1", "value": health["open_p1"], "source": "exceptions"},
            {"label": "Lowest hub throughput", "value": f"{health['lowest_throughput_pct']:g}%", "source": "warehouse_status"},
            {"label": "Red SKUs", "value": health["red_skus"], "source": "inventory_positions"},
            {"label": "Demand uplift", "value": f"×{ctx['demand_uplift']:g}", "source": "demand_signals"},
            {"label": "Vehicles off road", "value": ctx["vor_count"], "source": "fleet_vehicles"},
        ]
        reasoning_steps = [
            {"step": 1, "rule": f"{cfg.get('module_label', 'Module')} · {cand['label']} is triggered by its own domain condition",
             "observation": cand["detail"],
             "inference": f"{cand['title']} is warranted now rather than at the next planning cycle.",
             "confidence": cand["confidence"]},
            {"step": 2, "rule": "Value at stake is measured before autonomy is considered",
             "observation": (f"£{cand['value_gbp']:,} committed" if cand.get("value_gbp")
                             else "No direct spend committed"),
             "inference": ("Spend is material — the value gate decides this one."
                           if cand.get("value_gbp", 0) > 10000 else
                           "Immaterial spend — severity and confidence decide this one."),
             "confidence": cand["confidence"]},
            {"step": 3, "rule": "Reversibility and blast radius set the ceiling on autonomy",
             "observation": f"{cfg.get('reversibility', 'reversible')} · {cfg.get('blast_radius', 'record')}-level impact",
             "inference": ("Irreversible or network-wide — this class is never self-executed."
                           if cfg.get("reversibility") == "irreversible" or cfg.get("blast_radius") == "network"
                           else "Bounded and recoverable — eligible for autonomous execution on policy."),
             "confidence": cand["confidence"]},
        ]
        alternatives = self.action_alternatives(cand)
        return R.build_trace(
            action_key=cand.get("action_key") or cand["threshold_key"],
            threshold_key=cand["threshold_key"], owner_agent=cand["agent"],
            subject=cand["title"], cfg=cfg, ctx=ctx,
            guardrails={"auto_approve_under_gbp": 25000, "requires_dual_control_over_gbp": 100000,
                        "spend_ceiling_gbp": 250000},
            signals=signals, reasoning=reasoning_steps, proposal=cand["detail"],
            alternatives=alternatives, agent_autonomy="auto", ai_enabled=self._ai_mode,
            executed=executed, executed_by="ATLAS · autonomous" if executed else None)

    @staticmethod
    def action_alternatives(cand: dict) -> list[dict]:
        """What else was on the table. An action nobody weighed alternatives for
        is an action nobody actually decided. Public because the agent engine
        traces live recommendations against the same option set."""
        generic = [{"option": "Do nothing this cycle",
                    "projected": "Condition persists and worsens into the next planning window",
                    "rejected_because": "The trigger condition is already breached — waiting only raises the cost of the same fix."}]
        by_key = {
            "raise_po_standard": [
                {"option": "Wait for the next weekly planning run",
                 "projected": "Cover drops below the reorder point before the order is placed",
                 "rejected_because": "The lead time is longer than the cover remaining."},
                {"option": "Cover from another site by transfer instead",
                 "projected": "Faster, but strands the donor site",
                 "rejected_because": "No site holds surplus above its own safety stock for this SKU."}],
            "raise_po_emergency": [
                {"option": "Raise a standard PO at normal freight",
                 "projected": "Stock lands after the cover runs out — failed first visits in the gap",
                 "rejected_because": "Standard lead time does not close the exposure window."},
                {"option": "Cover by inter-site transfer",
                 "projected": "No premium, but only partial cover",
                 "rejected_because": "Network-wide position is short — there is nothing to move."}],
            "expedite_po": [
                {"option": "Let the order land on its original date",
                 "projected": "Cover gap of several days on a critical SKU",
                 "rejected_because": "The gap falls inside the demand window the forecast already flagged."}],
            "activate_plan": [
                {"option": "Acknowledge only and monitor",
                 "projected": "SLA clock runs while the compensating actions sit unstarted",
                 "rejected_because": "The playbook exists precisely for this signature of incident."}],
            "locker_failover": [
                {"option": "Leave collections pointed at the failed sites",
                 "projected": "Engineers arrive to unconfirmed stock and lose the first job",
                 "rejected_because": "Healthy sites are within the same round with spare capacity."}],
            "supplier_review": [
                {"option": "Watch-list only and keep trading",
                 "projected": "Exposure keeps growing while the counterparty is in distress",
                 "rejected_because": "A financial-health flag is a step change, not drift."}],
            "resolve_defect": [
                {"option": "Leave the vehicle off road until the next service slot",
                 "projected": "Round lost for the whole period",
                 "rejected_because": "The defect is clearable within the day at a fraction of the cost."}],
            "van_inter_transfer": [
                {"option": "Order the parts onto tonight's replenishment wave",
                 "projected": "Van correct by 07:00 tomorrow, today's jobs still fail",
                 "rejected_because": "The shortage bites this morning; the wave cannot land before it."},
                {"option": "Send the engineer to a trade counter",
                 "projected": "Certain stock, but a longer detour and a counter charge",
                 "rejected_because": "Another van holds the part inside 15 miles at no cost."}],
            "van_collect_en_route": [
                {"option": "Transfer from another van",
                 "projected": "No spend, but two rounds lose time",
                 "rejected_because": "No van within reach holds surplus above its own minimum."},
                {"option": "Reallocate the job",
                 "projected": "Appointment protected, but two working days rewritten",
                 "rejected_because": "A short detour keeps the original engineer on the original job."}],
            "van_replenishment_order": [
                {"option": "Leave the vans short until the next scheduled review",
                 "projected": "The same alerts return tomorrow, and again the day after",
                 "rejected_because": "Nothing structural changes until the van is ordered back to standard."}],
            "van_job_reallocation": [
                {"option": "Collect the part en route",
                 "projected": "Original engineer keeps the job but arrives late",
                 "rejected_because": "The detour pushes a contractual appointment past its window."}],
            "locker_provider_ticket": [
                {"option": "Fix the morning operationally and say nothing",
                 "projected": "Engineer hours lost are absorbed as our cost",
                 "rejected_because": "The availability SLA exists precisely for this; an unlogged miss is unrecoverable."}],
            "carrier_escalate": [
                {"option": "Re-book with the standby carrier",
                 "projected": "Recovers more of the slip, pays a second freight charge",
                 "rejected_because": "The consignment is still moving inside the incumbent's network — escalation is free."},
                {"option": "Wait for the revised ETA",
                 "projected": "The slip stands and the jobs behind it fail",
                 "rejected_because": "Nobody is holding the carrier to a committed time."}],
            "carrier_cover_from_hub": [
                {"option": "Keep waiting on the late leg",
                 "projected": "Engineer stands idle and the visit is lost anyway",
                 "rejected_because": "Stock that solves the job today is already sitting at the nearest hub."}],
            "carrier_rebook_job": [
                {"option": "Send the engineer and hope the unit lands",
                 "projected": "A wasted visit and an unhappy customer at the door",
                 "rejected_because": "A two-man unit cannot be substituted — the visit cannot succeed without it."}],
            "eta_reroute": [
                {"option": "Reallocate the at-risk appointments instead",
                 "projected": "Windows protected, but two engineers' days rewritten",
                 "rejected_because": "Re-sequencing recovers enough of the slip without moving anybody's round."},
                {"option": "Let the round run and apologise at the door",
                 "projected": "Contractual breach plus a complaint",
                 "rejected_because": "The slack to absorb it exists later in the same round."}],
            "eta_notify_customer": [
                {"option": "Say nothing and hope the delay closes",
                 "projected": "The customer discovers the miss themselves",
                 "rejected_because": "A warned customer is a delay; an unwarned one is a complaint."}],
            "eta_escalate": [
                {"option": "Work it quietly within dispatch",
                 "projected": "Breach happens with no owner and no customer comms",
                 "rejected_because": "A contractual window is about to be missed — it needs a named owner and a clock."}],
        }
        return by_key.get(cand["threshold_key"], []) + generic

    def _apply_ai_autonomous_response(self, scenario_id: str) -> dict:
        """Layer ATLAS's autonomous response over the state that has just been
        applied. Roughly four actions in five are executed under the guardrails
        the business already granted; the rest — irreversible, high-value or
        judgement calls — are left in the approval queue with the reasoning
        that got them there."""
        s = self._snapshot
        health_before = self.health_state()
        candidates = self._ai_action_demand()

        executed: list[dict] = []
        pending: list[dict] = []
        for cand in candidates:
            cfg = ACTION_THRESHOLDS.get(cand["threshold_key"], {})
            # The global auto-approve guardrail is a SPEND limit, so it only
            # applies to actions that actually commit money. A stock relocation
            # answers to its own ceiling and nothing else.
            caps = [cfg.get("value_ceiling_gbp", 0)]
            if cfg.get("commits_spend"):
                caps.append(AI_AUTO_APPROVE_GBP)
            caps = [x for x in caps if x > 0]
            eligible = (
                cfg.get("autonomy") == "auto"
                and not cfg.get("dual_control")
                and SEV_RANK_AI.get(cand["severity"], 9) >= SEV_RANK_AI.get(cfg.get("severity_ceiling", "medium"), 2)
                and cand["confidence"] >= cfg.get("confidence_floor", 70)
                and (not cand.get("value_gbp") or not caps or cand["value_gbp"] <= min(caps))
            )
            if eligible:
                self._ai_execute(cand)
                executed.append({**cand, "outcome": "auto_executed",
                                 "trace": self._ai_trace(cand, executed=True)})
            else:
                pending.append({**cand, "outcome": "escalated",
                                "trace": self._ai_trace(cand, executed=False)})

        # ── Recovery. Autonomous execution is not cosmetic: the actions above
        # moved real state (stock in, defects cleared, lockers re-pointed), so the
        # derived KPI families must be pulled back with them. 85% of the way to
        # target reflects a network that has been worked, not one that was never hit.
        self._ai_recover_kpis(scenario_id)
        self._recompute_inventory_dos()
        self._sync_derived_state()
        health_after = self.health_state()

        total = len(candidates) or 1
        summary = {
            "mode": "on", "total_actions": len(candidates), "autonomous": len(executed),
            "human_required": len(pending),
            "autonomy_pct": round(len(executed) / total * 100),
            "health_before": health_before["state"], "health_after": health_after["state"],
            "value_committed_gbp": sum(a.get("value_gbp", 0) for a in executed),
            "value_awaiting_approval_gbp": sum(a.get("value_gbp", 0) for a in pending),
        }
        block = {
            "enabled": True, "scenario_id": scenario_id,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "summary": summary, "health_before": health_before, "health_after": health_after,
            "actions": executed, "pending": pending,
            "narrative": (
                f"ATLAS worked this state autonomously: {len(executed)} of {len(candidates)} actions "
                f"({summary['autonomy_pct']}%) executed inside their guardrails, moving the network from "
                f"{health_before['state'].replace('_', ' ')} to {health_after['state'].replace('_', ' ')}. "
                f"{len(pending)} decision(s) were escalated — the irreversible, the high-value and the "
                f"judgement calls."),
        }
        s["ai_response"] = block
        # Hand the executed actions to the agent engine's audit feed so the
        # Automated · 24h and Audit Log tabs show them with their traces.
        s.setdefault("agent_layer", {})["ai_activity"] = [{
            "ts": datetime.now(timezone.utc).isoformat(),
            "agent_id": a["agent"], "agent_name": a.get("module_label", ""),
            "module_label": a.get("module_label"), "kind": "auto",
            "title": a["title"],
            "detail": f"Auto-executed within guardrails · {a['detail']}",
            "by": "fleet-auto", "trace": a["trace"],
        } for a in executed[:40]]
        return block

    def _ai_execute(self, cand: dict) -> None:
        """Make the autonomous action real in the snapshot. Each branch mutates
        exactly what the human clicking that button would have mutated."""
        s = self._snapshot
        tk = cand["threshold_key"]
        try:
            # ── Operational resolutions ─────────────────────────────────────
            # Routed through the same handler a human clicking that option would
            # hit, so the state change, the audit trail, the route surgery and
            # the outbound posts are identical — the only difference is the name
            # on the decision.
            if cand.get("resolution_kind"):
                self.apply_resolution(cand["resolution_kind"], cand["subject"],
                                      cand["resolution_action"], "ATLAS · autonomous")
                return
            if tk == "acknowledge":
                self.acknowledge_exception(cand["subject"], "ATLAS · autonomous", "Auto-acknowledged within guardrails.")
            elif tk == "raise_po_standard" and cand.get("sku_code"):
                self.create_purchase_order({
                    "sku_code": cand["sku_code"], "supplier_code": "WOL_UK", "warehouse_code": NDC_CODE,
                    "po_type": "standard", "quantity": cand.get("quantity") or 0,
                    "notes": "ATLAS — autonomous replenishment within guardrails."})
                for it in s.get("inventory_positions", []):
                    if it["sku_code"] == cand["sku_code"]:
                        it["quantity_on_hand"] = (it.get("quantity_on_hand") or 0) + round((cand.get("quantity") or 0) * 0.6)
            elif tk == "raise_transfer":
                # One rebalancing run: every short position is topped back up to its
                # own safety stock from network surplus, and the first few carry a
                # real STO so the move is visible in Stock Transfers, not just in
                # the numbers.
                batch = set(cand.get("batch") or ([cand["sku_code"]] if cand.get("sku_code") else []))
                raised = 0
                for it in s.get("inventory_positions", []):
                    if it["sku_code"] not in batch:
                        continue
                    floor = it.get("safety_stock_level") or 0
                    if (it.get("quantity_on_hand") or 0) < floor:
                        if raised < 5:
                            self.create_transfer_order({
                                "sku_code": it["sku_code"], "to_warehouse": NDC_CODE,
                                "quantity": max(1, floor - (it.get("quantity_on_hand") or 0)),
                                "notes": "ATLAS — autonomous network cover within guardrails."})
                            raised += 1
                        it["quantity_on_hand"] = floor
                        it["covered_by_atlas"] = True
            elif tk == "expedite_po" and cand.get("sku_code"):
                po = next((p for p in s.get("purchase_orders", [])
                           if p.get("sku_code") == cand["sku_code"]
                           and p.get("status") in ("draft", "confirmed", "in_transit")), None)
                if po:
                    self.expedite_purchase_order(po["po_number"])
            elif tk == "resolve_defect" and cand.get("registration"):
                v = next((x for x in s.get("fleet_vehicles", []) if x["registration"] == cand["registration"]), None)
                if v:
                    for d in v.get("defects", []):
                        if d.get("status") == "open" and d.get("severity") != "major":
                            d["status"] = "resolved"
                    if not any(d.get("severity") == "major" and d.get("status") == "open" for d in v.get("defects", [])):
                        v["vor"] = False
            elif tk == "walkaround_reminder":
                # ATLAS pushes the reminder; the drivers sign. Most respond within
                # the hour — the ones who don't stay visible as a compliance gap.
                missing = [v for v in s.get("fleet_vehicles", []) if not v.get("walkaround_completed") and not v.get("vor")]
                for v in missing[: round(len(missing) * 0.75)]:
                    v["walkaround_completed"] = True
                    v["walkaround_time"] = datetime.now(timezone.utc).isoformat()
            elif tk == "locker_failover":
                for l in s.get("locker_status", []):
                    if l.get("status") == "alert" and not l.get("pre_8am_delivered"):
                        l["pre_8am_delivered"] = True
                        l["status"] = "healthy"
                        l["failover_site"] = "nearest healthy site"
                self.refresh_locker_misses()
            # ── Operational resolutions ATLAS may run itself ────────────────
            # Each one goes through the same handler a human clicking that
            # option would, so the audit trail, the route surgery and the
            # outbound posts are identical — the only difference is who decided.
            elif tk == "reroute_inbound" and cand.get("shipment_ref"):
                for sh in s.get("shipments", []):
                    if sh.get("shipment_ref") == cand["shipment_ref"]:
                        sh["cover_rerouted"] = True
                        sh["delay_hours"] = round((sh.get("delay_hours") or 0) * 0.5, 1)
                        if (sh.get("delay_hours") or 0) < 4 and sh.get("status") == "delayed":
                            sh["status"] = "in_transit"
            elif tk == "flag_throughput" and cand.get("warehouse_code"):
                for w in s.get("warehouse_status", []):
                    if w["code"] == cand["warehouse_code"]:
                        w["throughput_vs_baseline_pct"] = round(
                            self._recover(w.get("throughput_vs_baseline_pct", 100), 92, frac=0.8), 1)
                        w["items_per_hour"] = round(w.get("baseline_items_per_hour", 3500)
                                                    * w["throughput_vs_baseline_pct"] / 100)
                        w["ai_mitigated"] = True
            elif tk == "otif_watchlist" and cand.get("supplier_code"):
                for sc in s.get("supplier_scorecards", []):
                    if sc.get("supplier_code") == cand["supplier_code"]:
                        sc["otif_watchlist"] = True
                        sc["watchlist_added_by"] = "ATLAS · autonomous"
            elif tk == "pre_position":
                # Cold-snap demand lands on boiler and heat-pump parts — those are
                # the positions moved forward to the hubs that will feel it first.
                for it in s.get("inventory_positions", []):
                    if it.get("category") in ("boiler", "heat_pump") and it.get("rag_status") in ("A", "R"):
                        it["quantity_on_hand"] = round((it.get("quantity_on_hand") or 0) * 1.25) + 5
                        it["pre_positioned"] = True
            elif tk == "proactive_outreach":
                hive = (s.get("demand_signals", {}) or {}).get("hive_faults")
                if isinstance(hive, dict):
                    hive["proactive_outreach_queued"] = hive.get("high_probability_signals_24h", 0)
            elif tk == "collection_sweep":
                # A consolidated sweep pulls units forward through the funnel:
                # most of what is sitting at the job/trade counter reaches HTS.
                pipe = s.get("reverse_pipeline", {}) or {}
                stages = {st["stage"]: st for st in pipe.get("stages", [])} if isinstance(pipe, dict) else {}
                moved = 0
                for name in ("Decommissioned at Job", "At Trade Counter"):
                    st = stages.get(name)
                    if st:
                        shift = round(st.get("count", 0) * 0.6)
                        st["count"] = max(0, st.get("count", 0) - shift)
                        moved += shift
                if moved and "HTS Received" in stages:
                    stages["HTS Received"]["count"] += moved
                if isinstance(pipe, dict):
                    pipe["last_sweep_by"] = "ATLAS · autonomous"
            elif tk == "create_disposition" and cand.get("sku_code"):
                self.create_disposition({"sku_code": cand["sku_code"], "action": "rebalance",
                                         "notes": "ATLAS — autonomous excess release within guardrails."})
        except Exception as exc:   # a demo snapshot should never 500 on a mutation
            _log.warning("AI autonomous action %s failed: %s", tk, exc)

    def _ai_recover_kpis(self, scenario_id: str) -> None:
        """Pull the KPI families back in line with what the autonomous actions
        actually did. Applied as a plan-effect override so it survives ticks —
        the same mechanism a human-activated response plan uses, at the higher
        recovery fraction a fleet working the whole incident in parallel earns."""
        s = self._snapshot
        k = s.get("kpis", {})
        F = 0.85   # autonomous response recovers most, but never all, of the loss

        def pull(key, target, lower_better=False):
            if key in k and isinstance(k[key], dict) and "value" in k[key]:
                k[key] = self._kpi(round(self._recover(k[key]["value"], target, frac=F,
                                                       lower_better=lower_better), 1),
                                   target, k[key].get("unit", "pct"), lower_better)

        pull("first_time_fix_rate", 86)
        pull("pre_8am_success_rate", 96)
        pull("in_boot_availability", 93)
        pull("expediting_cost_pct", 2.4, lower_better=True)
        pull("p1_response_time_min", 3, lower_better=True)

        # ── Supplier OTIF is DERIVED from the scorecards (volume-weighted), so it
        # only moves if the underlying delivery performance moves. Chasing every
        # late line, expediting what has slipped and holding watch-listed suppliers
        # to weekly reporting is precisely what recovers OTIF — so the recovery is
        # applied to the scorecards, and orders_on_time is kept consistent with it
        # rather than the headline being written over the top of stale detail.
        for sc in s.get("supplier_scorecards", []):
            cur = sc.get("otif_score")
            if cur is None or cur >= 93:
                continue
            sc["otif_score"] = round(self._recover(cur, 94, frac=F), 1)
            placed = sc.get("orders_placed") or 0
            if placed:
                sc["orders_on_time"] = round(placed * sc["otif_score"] / 100)
            sc["otif_recovered_by_atlas"] = True

        # ── Warehouse failover. A collapsed site does not recover just because an
        # agent looked at it — what recovers is the NETWORK, because the volume it
        # can no longer handle is pushed to sites that can. Anything under 60% is
        # treated as bypassed: it claws back only a little, and its lost volume is
        # redistributed across the healthy sites (capped at 112% of their own
        # baseline, which is what a warm site can absorb before it becomes the
        # next bottleneck).
        whs = s.get("warehouse_status", [])
        stranded = 0.0
        for w in whs:
            cur = w.get("throughput_vs_baseline_pct")
            base = w.get("baseline_items_per_hour", 3500) or 3500
            if cur is None:
                continue
            if cur < 60:
                new = round(self._recover(cur, 70, frac=0.5), 1)   # partial on-site recovery only
                stranded += (100 - new) / 100 * base
                w["throughput_vs_baseline_pct"] = new
                w["bypassed_by_failover"] = True
            elif cur < 88:
                w["throughput_vs_baseline_pct"] = round(self._recover(cur, 95, frac=F), 1)
            w["items_per_hour"] = round(base * w["throughput_vs_baseline_pct"] / 100)
            w["is_disrupted"] = w["throughput_vs_baseline_pct"] < 70

        if stranded > 0:
            healthy = [w for w in whs if not w.get("bypassed_by_failover")]
            headroom = sum(max(0.0, 1.12 - (w.get("throughput_vs_baseline_pct", 100) / 100))
                           * (w.get("baseline_items_per_hour", 3500) or 3500) for w in healthy)
            absorbed = min(stranded, headroom)
            if headroom > 0:
                for w in healthy:
                    base = w.get("baseline_items_per_hour", 3500) or 3500
                    cap = max(0.0, 1.12 - (w.get("throughput_vs_baseline_pct", 100) / 100)) * base
                    share = (cap / headroom) * absorbed
                    w["throughput_vs_baseline_pct"] = round(
                        w.get("throughput_vs_baseline_pct", 100) + share / base * 100, 1)
                    w["items_per_hour"] = round(base * w["throughput_vs_baseline_pct"] / 100)
                    w["absorbing_failover"] = round(share) > 0

        # Engineers left dry get restocked by the transfers and pre-positioning above.
        low = [e for e in s.get("engineer_locations", []) if e.get("van_stock_low")]
        for e in low[: round(len(low) * F)]:
            e["van_stock_low"] = False

        # Derived KPI-family overrides: the scenario's degradation, mostly repaired.
        base = dict(self._SCENARIO_DERIVED.get(scenario_id or "", {}))
        recovered = {}
        for key, val in base.items():
            if key in ("sla_breach_add", "cost_install_add"):
                recovered[key] = round(val * (1 - F), 2)
            elif key == "freight_mult":
                recovered[key] = round(self._recover(val, 1.0, frac=F, lower_better=True), 3)
            elif key in ("forecast_accuracy", "fuel_mpg", "inventory_accuracy"):
                target = {"forecast_accuracy": 90, "fuel_mpg": 38, "inventory_accuracy": 98}[key]
                recovered[key] = round(self._recover(val, target, frac=F), 2)
            elif key == "scope3":
                recovered[key] = round(self._recover(val, 2000, frac=F, lower_better=True))
        self._plan_effect_overrides["__atlas_autonomous__"] = recovered

    def set_ai_mode(self, enabled: bool) -> dict:
        """Flip the master switch. If a scenario is live it is re-applied through
        the other variation, so the toggle is a genuine A/B of the same state
        rather than a cosmetic change to the UI."""
        enabled = bool(enabled)
        changed = enabled != self._ai_mode
        self._ai_mode = enabled
        if changed:
            self.apply_scenario(self._active_scenario or "normal", ai_mode=enabled)
        return {"ai_mode": self._ai_mode, "scenario": self._active_scenario,
                "health": self.health_state(),
                "summary": self._snapshot.get("ai_response", {}).get("summary")}

    @property
    def ai_mode(self) -> bool:
        return self._ai_mode

    @property
    def world_token(self) -> str:
        """Identity of the world as it stands. Changes only when the snapshot is
        rebuilt (scenario, reset, regenerate) — never on a tick, which only moves
        stochastic values within the same world."""
        return self._world_token

    def _new_world(self) -> str:
        self._world_token = uuid.uuid4().hex[:12]
        self._snapshot["world_token"] = self._world_token
        # Holds protect the effect of an action against the simulation. A new
        # world means those actions were taken about state that no longer exists,
        # so the protection lapses with them.
        self._holds = {}
        return self._world_token

    def ai_response(self) -> dict:
        """The AI-ON/AI-OFF variation block for whatever state is current."""
        block = self._snapshot.get("ai_response")
        if not block or block.get("enabled") != self._ai_mode:
            block = (self._apply_ai_autonomous_response(self._active_scenario or "normal")
                     if self._ai_mode else self._ai_response_off(self._active_scenario or "normal"))
            self._snapshot["ai_response"] = block
        return block

    def _apply_transport_impact(self, traffic: str = "normal", vor_add: int = 0,
                                walkaround_missing_add: int = 0, defect_desc: str | None = None,
                                ev_charge_penalty: int = 0, travel_mins_pct: float = 0):
        """Scenario side-effects on Transport Control — the fleet itself (VOR,
        walkarounds, EV range) plus road speed applied to engineer routes.

        The transport KPI family is deliberately NOT set here: _sync_derived_state
        derives it from this state (utilisation from the real VOR count, on-time
        from traffic severity, transit exceptions from delayed shipments, freight
        and MPG from _SCENARIO_DERIVED) and would overwrite anything set directly."""
        s = self._snapshot
        s["traffic_severity"] = traffic
        fleet = s.get("fleet_vehicles", [])
        now = datetime.now(timezone.utc)

        # ── Road conditions → route travel time. Slower roads also erode the
        # minutes that route optimisation had banked.
        if travel_mins_pct:
            f = 1 + travel_mins_pct / 100.0
            for route in s.get("engineer_routes", {}).values():
                if not isinstance(route, dict):
                    continue
                for key in ("planned_travel_mins", "optimized_travel_mins"):
                    if isinstance(route.get(key), (int, float)):
                        route[key] = round(route[key] * f)
                route["mins_saved"] = max(0, round((route.get("mins_saved") or 0) / f))
                for stop in route.get("stops", []):
                    stop["at_risk"] = True

        if vor_add and defect_desc:
            candidates = [v for v in fleet if not v["vor"]]
            for v in random.sample(candidates, k=min(vor_add, len(candidates))):
                v["defects"].append({
                    "defect_id": f"DEF-{random.randint(90000, 99999)}",
                    "description": defect_desc,
                    "severity": "major",
                    "reported_at": now.isoformat(),
                    "status": "open"},)
                v["vor"] = True
        if walkaround_missing_add:
            done = [v for v in fleet if v["walkaround_completed"]]
            for v in random.sample(done, k=min(walkaround_missing_add, len(done))):
                v["walkaround_completed"] = False
                v["walkaround_time"] = None
        if ev_charge_penalty:
            for v in fleet:
                if v["fuel_type"] == "ev" and v["ev_charge_pct"] is not None:
                    v["ev_charge_pct"] = max(8, v["ev_charge_pct"] - ev_charge_penalty)
                    v["ev_range_miles"] = int(v["ev_range_miles"] * 0.7)  # cold-weather range loss

    # ── Scenario A: P1 3PL Site Closure ──────────────────────────────────────

    def _scenario_p1_3pl_closure(self):
        s = self._snapshot
        now = datetime.now(timezone.utc)

        # Warehouse: Leicester NDC collapses to 14.8%
        for wh in s["warehouse_status"]:
            if wh["code"] == "LEI_COE":
                wh["throughput_vs_baseline_pct"] = 14.8
                wh["items_per_hour"] = 518
                wh["courier_ot_rate"] = 62.0
                wh["staff_present"] = 8
                wh["is_disrupted"] = True
                wh["throughput_chart"] = [
                    {"hour": h, "items_per_hour": round(518 * self._hourly_factor(h) * 0.15)}
                    for h in range(24)
                ]
            elif wh["code"] == "COV_HUB":
                # Coventry absorbs overflow – climbs to 115%
                wh["throughput_vs_baseline_pct"] = 115.0
                wh["items_per_hour"] = round(wh["baseline_items_per_hour"] * 1.15)

        # 35% of lockers miss pre-8AM (no Leicester dispatch)
        for i, locker in enumerate(s["locker_status"]):
            if i % 3 == 0:
                locker["pre_8am_delivered"] = False
                locker["status"] = "alert"

        # Labour risk at Leicester is derived by _apply_labour_state() via
        # SCENARIO_LABOUR_RANGES["p1_3pl_closure"] once this scenario is active.

        # Inbound freight stuck — the site cannot book anything in. Supplier
        # shipments all land at the NDC, so a full closure holds up the lot.
        for sh in s["shipments"]:
            if sh.get("destination_warehouse") == "LEI_COE":
                sh["status"] = "delayed"
                sh["delay_hours"] = round(rnd(18, 72), 1)
                sh["alert_raised"] = True

        # Inject P1 exception
        self._exception_counter += 1
        s["exceptions"].insert(0, {
            "exception_code": f"EXC-DEMO-P1-{self._exception_counter:04d}",
            "priority": "P1",
            "category": "3pl_disruption",
            "title": "LIVE: TVS SCS Leicester NDC Full Site Closure – Throughput at 14.8%",
            "description": (
                "Leicester NDC has fallen to 14.8% of baseline throughput (518 items/hr vs 3,500 baseline). "
                "Cause: Industrial action by GMB. 4,200 field engineers at risk of parts shortage within 4 hours. "
                "Coventry Hub activated as overflow (115% capacity). 1,640 locker pre-8AM deliveries missed."
            ),
            "impacted_engineer_count": 4200,
            "impacted_skus": ["SKU-BLR-001", "SKU-BLR-002", "SKU-BLR-003", "SKU-SM-001"],
            "estimated_resolution_hours": 12.0,
            "recommended_action": "Follow the 3PL Site Failover playbook immediately. Reroute to Coventry + 4 regional trade counters. Alert all field dispatchers.",
            "status": "open",
            "automated_action_taken": "3PL business continuity plan invoked and incident bridge opened with TVS SCS. Inbound deliveries auto-diverted to Coventry; hub STOs re-pointed to source from Coventry. SMS broadcast queued to 4,200 engineers.",
            "scenario_id": "p1_3pl_closure",
            "alert_channels_notified": {"in_app": True, "email": True, "sms": True, "slack": True},
            "recurrence_count": 1,
            "created_at": now.isoformat(),
            "updated_at": now.isoformat()},)

        # Disruption at worst before playbook fires
        s["executive_kpis"].update({
            "first_time_fix_rate":   {"value": 61.2, "target": 82, "unit": "pct", "rag": "R", "trend": "down"},
            "expediting_cost_pct":   {"value": 18.5, "target": 3.0, "unit": "pct", "rag": "R", "trend": "up"},
            "p1_response_time_min":  {"value": 2.1,  "target": 5,   "unit": "minutes", "rag": "G", "trend": "up"}},)
        s["operational_kpis"].update({
            "pre_8am_delivery_success": {"value": 64.2, "target": 95, "unit": "pct", "rag": "R"},
            "in_boot_availability":     {"value": 52.3, "target": 90, "unit": "pct", "rag": "R"}},)
        s["field_dispatcher_kpis"].update({
            "locker_gaps_count":   1640,
            "van_stock_low_count": 380,
            "pending_transfers":   214},)
        s["kpis"]["first_time_fix_rate"] = {"value": 61.2, "target": 82, "unit": "pct", "rag": "R"}
        s["kpis"]["expediting_cost_pct"] = {"value": 18.5, "target": 3.0, "unit": "pct", "rag": "R"}
        s["kpis"]["pre_8am_success_rate"] = {"value": 64.2, "target": 95, "unit": "pct", "rag": "R"}
        s["lockers_healthy_pct"] = 64.2

        # ── Knock-on: the closed site is the National Distribution Centre — the only
        # place suppliers deliver into and the source of every hub STO. Nothing moves
        # in or out, so hub cover starts burning down with no replenishment behind it.
        self._impact_inventory(on_hand_pct=-22, max_skus=400)
        self._impact_field(van_stock_low_pct=41)

    # ── Scenario B: P2 Critical Stockout ─────────────────────────────────────

    def _scenario_p2_stockout(self):
        s = self._snapshot
        now = datetime.now(timezone.utc)

        # Diverter valve hits zero; PCB board also critically low
        for item in s["inventory_positions"]:
            if item["sku_code"] == "SKU-BLR-001":
                item["quantity_on_hand"] = 0
            elif item["sku_code"] == "SKU-BLR-004":
                item["quantity_on_hand"] = 4

        # 412 engineers flagged with van stock low (missing diverter valve)
        for i, eng in enumerate(s["engineer_locations"]):
            if i % 2 == 0:
                eng["van_stock_low"] = True
                for item in eng.get("van_stock_items", []):
                    if item["sku_code"] == "SKU-BLR-001":
                        item["quantity"] = 0
                        item["is_below_min"] = True

        # Inject P2 exception
        self._exception_counter += 1
        s["exceptions"].insert(0, {
            "exception_code": f"EXC-DEMO-P2-{self._exception_counter:04d}",
            "priority": "P2",
            "category": "critical_stockout",
            "title": "LIVE: Diverter Valve (SKU-BLR-001) Zero Stock – 847 Jobs at Risk",
            "description": (
                "Diverter Valve SKU-BLR-001 (Vaillant ecoTEC, Navien NCB-E compatible) has reached "
                "zero stock at all 4 warehouse locations. 847 boiler repair jobs scheduled in next 48 hours "
                "cannot be fulfilled. 412 field engineers report zero van stock for this SKU. "
                "Estimated customer impact: 847 SLA breaches, £340k penalty exposure."
            ),
            "impacted_engineer_count": 847,
            "impacted_skus": ["SKU-BLR-001"],
            "estimated_resolution_hours": 48.0,
            "recommended_action": "Raise emergency PO via Ariba (target: 48hr delivery). Initiate inter-engineer transfers. Alert trade counters.",
            "status": "open",
            "automated_action_taken": "Van stock swept network-wide and remaining units redirected to P1 and vulnerable-customer jobs. Sister-hub lateral rebalance checked before buying. Emergency PO PO-DEMO-EMG drafted in SAP Ariba; transfer broadcast sent to 412 engineers.",
            "scenario_id": "p2_stockout",
            "alert_channels_notified": {"in_app": True, "email": True, "sms": True, "slack": True},
            "recurrence_count": 1,
            "created_at": now.isoformat(),
            "updated_at": now.isoformat()},)

        # Emergency PO at top of list
        self._po_counter += 1
        s["purchase_orders"].insert(0, {
            "po_number": f"PO-EMG-{self._po_counter:04d}",
            "supplier_code": "VAI_UK",
            "supplier_name": "Vaillant UK Ltd",
            "warehouse_code": "LEI_COE",
            "po_type": "emergency",
            "status": "confirmed",
            "total_value_gbp": 84200.00,
            "is_auto_generated": True,
            "ariba_checked": True,
            "ordered_at": now.isoformat(),
            "expected_delivery": (now + timedelta(hours=48)).isoformat()},)

        # Executive KPIs: FTFR craters
        s["executive_kpis"].update({
            "first_time_fix_rate": {"value": 64.2, "target": 82, "unit": "pct", "rag": "R", "trend": "down"},
            "expediting_cost_pct": {"value": 12.8, "target": 3.0, "unit": "pct", "rag": "R", "trend": "up"}},)

        s["operational_kpis"].update({
            "in_boot_availability": {"value": 42.1, "target": 90, "unit": "pct", "rag": "R"},
            "van_fill_accuracy":    {"value": 61.4, "target": 92, "unit": "pct", "rag": "R"}},)

        s["field_dispatcher_kpis"].update({
            "van_stock_low_count": 412,
            "pending_transfers":   312},)

        s["kpis"]["first_time_fix_rate"] = {"value": 64.2, "target": 82, "unit": "pct", "rag": "R"}
        s["kpis"]["expediting_cost_pct"] = {"value": 12.8, "target": 3.0, "unit": "pct", "rag": "R"}
        s["kpis"]["in_boot_availability"] = {"value": 42.1, "target": 90, "unit": "pct", "rag": "R"}

    # ── Scenario C: Beast from East ───────────────────────────────────────────

    def _scenario_beast_from_east(self):
        s = self._snapshot
        now = datetime.now(timezone.utc)

        # Weather signal: extreme cold
        s["demand_signals"]["weather"] = {
            "source": "Met Office",
            "region": "National (All UK)",
            "temp_c": -6.2,
            "forecast_7d_min_c": -9.1,
            "heating_degree_days_7d": 168.4,
            "demand_uplift_factor": 1.42,
            "beast_from_east_risk": True,
            "frozen_condensate_risk": True,
            "named_storm": "Storm Bram",
            "alert": "EXTREME COLD WARNING: Beast from East event. Boiler demand uplift ×1.42 across all regions."}

        # Hive Boiler IQ signals surge +45%; frozen condensate lockouts spike hardest
        s["demand_signals"]["hive_faults"] = {
            "high_probability_signals_24h": 5085,
            "top_fault_type": "heat_exchanger_degradation",
            "pre_positioning_triggered_today": 582,
            "condensate_lockout_signals_24h": 1840,
            "surge_vs_baseline_pct": 45.3}

        # HomeCare book flips to breakdown-led: planned services deferred, callouts triple
        sb = s["demand_signals"].get("service_book", {})
        sb.update({
            "season": "peak_heating",
            "breakdown_callouts_24h": 3140,
            "annual_services_due_30d": max(4_000, (sb.get("annual_services_due_30d") or 8_000) // 2),
            "boiler_switch_on_surge_risk": False},)
        s["demand_signals"]["service_book"] = sb

        # CPQ: boiler replacement BOMs spike
        s["demand_signals"]["cpq_pipeline"]["heat_pump_boms_active"] = 1240  # slight uptick for heat pumps
        s["demand_signals"]["cpq_pipeline"]["smart_meter_boms_active"] = 4980

        # Boiler fault pipeline: all signals spike to critical range. The
        # pre-positioning and outreach flags are deliberately NOT set here — they
        # are derived from parts cover, and the whole point of this scenario is
        # that cover collapses: boiler stock is cut to a third below, so the surge
        # produces signals the network genuinely cannot cover. Forcing the flags
        # true would paper over exactly the failure the scenario is meant to show.
        for fault in s["boiler_fault_pipeline"]:
            fault["fault_probability"] = min(0.9999, fault["fault_probability"] * 1.45)
            fault["replacement_probability_90d"] = min(0.9999, fault["replacement_probability_90d"] * 1.38)

        # Add 15 extra fault signals
        for i in range(15):
            brand = random.choice(BOILER_BRANDS)
            region = random.choice(UK_REGIONS)
            fault_type = random.choices(["heat_exchanger_degradation", "diverter_valve_failure"],
                                        weights=[60, 40])[0]
            sku, part = FAULT_PART_MAP[fault_type]
            s["boiler_fault_pipeline"].append({
                "device_id": f"HIVE-BEAST-{i:04d}",
                "property_postcode": rand_postcode(region),
                "region": region,
                "boiler_brand": brand,
                "boiler_model": random.choice(BOILER_MODELS.get(brand, ["Generic Model"])),
                "boiler_age_years": rnd(10, 22),
                "fault_type": fault_type,
                "required_sku": sku,
                "required_part": part,
                "fault_probability": rnd(0.87, 0.99, 4),
                "replacement_probability_90d": rnd(0.72, 0.99, 4),
                "signal_timestamp": now.isoformat()},)

        # Predictive replacements balloon to 28
        for _ in range(18):
            brand = random.choice(BOILER_BRANDS)
            s["predictive_replacements"].append({
                "device_id": f"HIVE-BEAST-RPL-{random.randint(1000,9999)}",
                "property_postcode": rand_postcode(),
                "boiler_brand": brand,
                "boiler_age_years": rnd(11, 20),
                "replacement_probability_90d": rnd(0.88, 0.99, 4),
                "recommended_replacement_unit": f"{brand} Latest Model",
                "outreach_queued": True,
                "estimated_job_date": (date.today() + timedelta(days=random.randint(2, 14))).isoformat()},)

        # Inventory: surge consumption depletes boiler stock at ×2.8 effective rate.
        # quantity_available has to follow quantity_on_hand — it is the figure
        # every downstream cover and DRP check actually reads, so cutting on-hand
        # alone left the network claiming stock it no longer had.
        for item in s["inventory_positions"]:
            if item.get("category") == "boiler":
                on_hand = max(0, round(item["quantity_on_hand"] / 2.8))
                reserved = min(on_hand, round(on_hand * 0.15))
                item["quantity_on_hand"] = on_hand
                item["quantity_reserved"] = reserved
                item["quantity_available"] = on_hand - reserved

        # Van stock: engineers are fitting parts all day at surge rate and the
        # overnight replenishment wave cannot refill from a depleted NDC. Without
        # this the vans stay fully stocked through the storm and the fault pipeline
        # reports 100% parts cover during the one event designed to break it.
        for eng in s.get("engineer_locations", []):
            for item in eng.get("van_stock_items", []) or []:
                if random.random() < 0.55:
                    item["quantity"] = max(0, item["quantity"] - random.randint(1, 2))
                    item["is_below_min"] = item["quantity"] < item["min_quantity"]
            eng["van_stock_low"] = any(v["quantity"] < v["min_quantity"]
                                       for v in eng.get("van_stock_items", []) or [])

        # Inject P3 exception for demand surge
        self._exception_counter += 1
        s["exceptions"].insert(0, {
            "exception_code": f"EXC-DEMO-BEAST-{self._exception_counter:04d}",
            "priority": "P3",
            "category": "demand_surge",
            "title": "Beast from East: Boiler Demand Surge ×1.42 – All Regions",
            "description": (
                "Met Office extreme cold warning active. Temperature forecast: -6.2°C (7-day low: -9.1°C). "
                "Boiler fault signals surged to 5,085/day (+45.3% vs baseline). "
                "28 properties added to proactive replacement pipeline. "
                "All boiler parts days-of-supply reduced to critical range. Emergency pre-positioning in progress."
            ),
            "impacted_engineer_count": 7200,
            "impacted_skus": ["SKU-BLR-001", "SKU-BLR-002", "SKU-BLR-003", "SKU-BLR-005"],
            "estimated_resolution_hours": 72.0,
            "recommended_action": "Raise contingency boiler parts POs (×1.5 volume). Accelerate pre-positioning to all ByBox lockers. Brief all 7,200 engineers.",
            "status": "open",
            "automated_action_taken": "Condensate and diverter-valve stock pre-positioned to the coldest-region hubs for 582 high-risk properties. Cold-weather routing enabled with vulnerable-customer priority. Emergency POs drafted on spiking boiler lines.",
            "scenario_id": "beast_from_east",
            "alert_channels_notified": {"in_app": True, "email": True, "sms": False, "slack": True},
            "recurrence_count": 1,
            "created_at": now.isoformat(),
            "updated_at": now.isoformat()},)

        # Executive KPIs: expediting cost rises, scope3 up (emergency couriers)
        s["executive_kpis"].update({
            "expediting_cost_pct": {"value": 9.8,  "target": 3.0, "unit": "pct", "rag": "R", "trend": "up"},
            "scope3_ytd_tco2e":    {"value": 2280, "target": 2000, "unit": "tco2e", "rag": "R", "trend": "up"}},)

        s["kpis"]["expediting_cost_pct"] = {"value": 9.8, "target": 3.0, "unit": "pct", "rag": "R"}

        # ── Knock-on: snow doesn't only lift demand, it slows the whole road network.
        # The 2018 event closed roads nationally and cost the UK ~£1bn/day; vans
        # crawl, burn more diesel, and some are immobilised outright.
        # Field: engineers can't reach every job, and vans empty faster than they refill
        self._impact_field(van_stock_low_pct=34, off_duty_pct=12)
        # 3PL: staff absence in the snow drags pick rates at every site
        for wh in s.get("warehouse_status", []):
            wh["throughput_vs_baseline_pct"] = round(wh.get("throughput_vs_baseline_pct", 95) * 0.82, 1)
            wh["items_per_hour"] = round(wh.get("baseline_items_per_hour", 2000) * wh["throughput_vs_baseline_pct"] / 100)
            wh["staff_present"] = round((wh.get("staff_present") or 40) * 0.79)
            wh["courier_ot_rate"] = round(min(wh.get("courier_ot_rate", 95), 72.5), 1)

    # ── Scenario D: Supplier Insolvency (Mitsubishi HVAC) ────────────────────

    def _scenario_supplier_insolvency(self):
        s = self._snapshot
        now = datetime.now(timezone.utc)

        # Mitsubishi HVAC scorecard: financial collapse
        for supplier in s["supplier_scorecards"]:
            if supplier["supplier_code"] == "MIT_HV":
                supplier["financial_health_flag"] = True
                supplier["otif_score"] = 0.0
                supplier["composite_risk_score"] = 3
                supplier["ariba_compliance_status"] = "expired"
                supplier["sedex_risk_level"] = "high"
                supplier["geopolitical_risk_flag"] = True
                supplier["review_triggered"] = True

        # Heat pump pipeline: Mitsubishi slot indefinitely blocked
        self._set_oem_override("MIT_HV", lead_time_weeks=99, open_pos=0,
                               next_hgv_slot="INDEFINITE", palletforce_bookings=0,
                               otif=0, status="SUSPENDED – Insolvency Risk")

        # All Mitsubishi inbound shipments → indefinitely delayed
        for sh in s["shipments"]:
            if sh.get("supplier_code") == "MIT_HV":
                sh["status"] = "delayed"
                sh["delay_hours"] = 240.0
                sh["alert_raised"] = True

        # Inject P2 exception (insolvency) + P4 (OTIF breach)
        self._exception_counter += 1
        s["exceptions"].insert(0, {
            "exception_code": f"EXC-DEMO-INS-{self._exception_counter:04d}",
            "priority": "P2",
            "category": "supplier_risk",
            "title": "URGENT: Mitsubishi HVAC – Financial Insolvency Risk Flag Raised",
            "description": (
                "SAP Ariba financial health monitoring has flagged Mitsubishi Electric HVAC (MIT_HV) "
                "with a critical insolvency risk signal. Ariba compliance expired. OTIF collapsed to 0%. "
                "12 open POs (£2.8M value) are at risk. Heat pump installation programme for Q3 at full risk. "
                "Legal reviewing contract termination clauses. Contingency sourcing initiated."
            ),
            "impacted_engineer_count": 0,
            "impacted_skus": ["SKU-HP-001"],
            "estimated_resolution_hours": 720.0,
            "recommended_action": "Engage Daikin/Samsung as contingency. Legal to review MIT_HV contract.",
            "status": "open",
            "automated_action_taken": "Stock in transit secured and further payments frozen pending retention-of-title review. Tooling and IP recovery request issued. Daikin Europe and Samsung HA contacted for emergency capacity.",
            "scenario_id": "supplier_insolvency",
            "alert_channels_notified": {"in_app": True, "email": True, "sms": True, "slack": True},
            "recurrence_count": 1,
            "created_at": now.isoformat(),
            "updated_at": now.isoformat()},)

        # Emergency contingency POs (Daikin + Samsung to cover Mitsubishi)
        for i, supplier_code in enumerate(["DAI_EU", "SAM_HA"]):
            self._po_counter += 1
            s["purchase_orders"].insert(0, {
                "po_number": f"PO-CONT-{self._po_counter:04d}",
                "supplier_code": supplier_code,
                "supplier_name": "Daikin Europe NV" if supplier_code == "DAI_EU" else "Samsung HA UK",
                "warehouse_code": "LEI_COE",
                "po_type": "contingency",
                "status": "draft",
                "total_value_gbp": round(rnd(280000, 620000), 2),
                "is_auto_generated": True,
                "ariba_checked": False,
                "ordered_at": now.isoformat(),
                "expected_delivery": (now + timedelta(weeks=18)).isoformat()},)

        # Executive KPIs: supplier OTIF tanks
        s["executive_kpis"].update({
            "supplier_otif": {"value": 74.3, "target": 92, "unit": "pct", "rag": "R", "trend": "down"}},)

        s["procurement_kpis"].update({
            "ariba_expired": 3,
            "ariba_expiring_30d": 8,
            "open_pos": s["procurement_kpis"].get("open_pos", 60) + 18,
            "emergency_pos_pct": 22.4},)

        s["kpis"]["supplier_otif"] = {"value": 74.3, "target": 92, "unit": "pct", "rag": "R"}

    # ── Scenario E: Heat Pump Install Surge ──────────────────────────────────

    def _scenario_heat_pump_surge(self):
        s = self._snapshot
        now = datetime.now(timezone.utc)

        # CPQ pipeline: government grant → 8× heat pump BOMs
        s["demand_signals"]["cpq_pipeline"]["heat_pump_boms_active"] = 9640

        # Add surge note to demand signals
        s["demand_signals"]["cpq_surge"] = {
            "trigger": "Government £7,500 grant extension announced 06:00 today",
            "heat_pump_quote_requests_24h": 9640,
            "vs_baseline": "×8.1 surge",
            "engineer_cert_shortage": True,
            "certified_engineers_available": 312,
            "jobs_queued_vs_capacity": "9,640 vs 312 certified engineers"}

        # Heat pump pipeline: installs at capacity limit, urgent OEM orders
        s["heat_pump_pipeline"]["installs_ytd"] = 6840
        s["heat_pump_pipeline"]["engineers_heat_pump_certified"] = 312
        s["heat_pump_pipeline"]["capacity_alert"] = True
        s["heat_pump_pipeline"]["surge_notes"] = "Government grant extension: 9,640 new quotes in 24h. OEM lead times at 18–20 weeks."
        for code in self._heat_pump_oem_codes():
            self._set_oem_override(code, lead_time_weeks_delta=6, open_pos_delta=24)

        # Inventory: HP SKUs critically depleted by surge demand
        for item in s["inventory_positions"]:
            if item["sku_code"] in ("SKU-HP-001", "SKU-HP-002"):
                item["quantity_on_hand"] = 3

        # Emergency OEM orders, and the urgent HGV freight against them. The PO is
        # the document; the shipment is its physical leg, built through the one
        # shared factory so the surge freight is traceable to an order like every
        # other inbound. (These used to be two independent loops over different
        # OEM lists — three shipments, two POs, nothing joining them.)
        for i, oem_code in enumerate(["MIT_HV", "DAI_EU", "SAM_HA"]):
            oem_name = next((sp["name"] for sp in SUPPLIER_DATA if sp["supplier_code"] == oem_code), oem_code)
            item = next((it for it in s.get("inventory_positions", [])
                         if it.get("primary_supplier") == oem_code and it.get("category") == "heat_pump"), None)
            qty = random.randint(260, 640)
            unit_cost = (item or {}).get("unit_cost_gbp") or 3200
            self._po_counter += 1
            po = {
                "po_number": f"PO-HP-SURGE-{self._po_counter:04d}",
                "sku_code": (item or {}).get("sku_code"),
                "description": (item or {}).get("description"),
                "supplier_code": oem_code,
                "supplier_name": oem_name,
                "warehouse_code": NDC_CODE,
                "po_type": "emergency",
                "quantity": qty,
                "status": "in_transit",
                "total_value_gbp": round(qty * unit_cost, 2),
                "is_auto_generated": True,
                "ariba_checked": True,
                "ordered_at": now.isoformat(),
                # OEM lead times are out at 18–20 weeks under the surge
                "expected_delivery": (now + timedelta(weeks=16 + i * 2)).isoformat()}
            s["purchase_orders"].insert(0, po)

            shipment = self._shipment_for_po(po, now, carrier="Palletforce HGV")
            shipment.update({"status": "in_transit", "delay_hours": 0, "alert_raised": False,
                             "predicted_arrival": shipment["scheduled_arrival"],
                             "urgency": "HIGH – Grant surge"})
            shipment.pop("ai_optimization", None)
            s["shipments"].insert(0, shipment)

        # Inject P3 exception
        self._exception_counter += 1
        s["exceptions"].insert(0, {
            "exception_code": f"EXC-DEMO-HP-{self._exception_counter:04d}",
            "priority": "P3",
            "category": "demand_surge",
            "title": "Heat Pump Demand Surge ×8.1 – Government Grant Extension (9,640 Quotes in 24h)",
            "description": (
                "Government announced £7,500 heat pump grant extension at 06:00. "
                "CPQ pipeline received 9,640 new heat pump quotes in 24 hours (×8.1 vs daily baseline). "
                "Current certified engineer capacity: 312. HP inventory: 3 units across all warehouses (0.8 days supply). "
                "Emergency POs placed with Mitsubishi and Daikin. OEM lead times 18–26 weeks. "
                "Customer SLA risk: 9,328 quotes cannot be fulfilled within 30 days."
            ),
            "impacted_engineer_count": 312,
            "impacted_skus": ["SKU-HP-001", "SKU-HP-002"],
            "estimated_resolution_hours": 2160.0,
            "recommended_action": "Emergency POs with all 3 OEMs. Accelerate heat pump engineer certification. Manage customer expectations via SFS.",
            "status": "open",
            "automated_action_taken": "New install bookings capped to the confirmed-stock horizon. Remaining kit allocated by customer commitment date. Emergency POs placed with Mitsubishi HVAC and Daikin Europe; Palletforce HGV slots booked.",
            "scenario_id": "heat_pump_surge",
            "alert_channels_notified": {"in_app": True, "email": True, "sms": False, "slack": True},
            "recurrence_count": 1,
            "created_at": now.isoformat(),
            "updated_at": now.isoformat()},)

        # Executive KPIs: expediting cost up (emergency HP procurement)
        s["executive_kpis"].update({
            "expediting_cost_pct": {"value": 11.2, "target": 3.0, "unit": "pct", "rag": "R", "trend": "up"}},)

        s["procurement_kpis"].update({
            "open_pos": s["procurement_kpis"].get("open_pos", 60) + 34,
            "emergency_pos_pct": 18.6},)

        s["kpis"]["expediting_cost_pct"] = {"value": 11.2, "target": 3.0, "unit": "pct", "rag": "R"}

    # ── Scenario G: Port Congestion (Felixstowe) ─────────────────────────────

    def _scenario_port_congestion(self):
        s = self._snapshot
        now = datetime.now(timezone.utc)

        # All inbound sea-freight shipments delayed 5–9 days
        delayed = 0
        for sh in s["shipments"]:
            if sh["status"] == "in_transit":
                sh["status"] = "delayed"
                sh["delay_hours"] = round(rnd(120, 216), 1)
                sh["alert_raised"] = True
                delayed += 1

        # Far-East supplier lead times stretch — DoS erodes on imported SKUs
        for item in s["inventory_positions"]:
            if item["sku_code"] in ("SKU-BLR-002", "SKU-BLR-004", "SKU-HP-001", "SKU-EV-001"):
                item["lead_time_days"] = round(item.get("lead_time_days", 14) * 1.6)
        for supplier in s["supplier_scorecards"]:
            if supplier["supplier_code"] in ("MIT_HV", "SAM_HA"):
                supplier["otif_score"] = round(rnd(58, 66), 1)
                supplier["composite_risk_score"] = 74
                supplier["geopolitical_risk_flag"] = True

        s["kpis"]["expediting_cost_pct"] = {"value": 7.8, "target": 3.0, "unit": "pct", "rag": "R"}
        s["kpis"]["supplier_otif"] = {"value": 63.0, "target": 92.0, "unit": "pct", "rag": "R"}

        # Imported heat pump kits sit in the delayed containers — OEM lead times stretch
        for code in self._heat_pump_oem_codes():
            self._set_oem_override(code, lead_time_weeks_delta=4, otif_delta=-18)

        self._exception_counter += 1
        s["exceptions"].insert(0, {
            "exception_code": f"EXC-PORT-P2-{self._exception_counter:04d}",
            "priority": "P2",
            "category": "inbound_delay",
            "title": "Felixstowe Congestion – 100% of Sea Freight Delayed 5–9 Days",
            "description": (
                f"Berth congestion at Felixstowe has delayed {delayed} inbound containers by 5–9 days. "
                "Far-East boiler and heat pump components affected. Lead times stretched ×1.6. "
                "Days-of-supply eroding on SKU-BLR-002, SKU-BLR-004, SKU-HP-001, SKU-EV-001."
            ),
            "impacted_engineer_count": 0,
            "impacted_skus": ["SKU-BLR-002", "SKU-BLR-004", "SKU-HP-001", "SKU-EV-001"],
            "estimated_resolution_hours": 168,
            "recommended_action": "Divert priority containers to London Gateway. Raise expedited air-freight PO for SKU-BLR-002.",
            "status": "open",
            "automated_action_taken": "SKUs on delayed vessels identified and those under 3 weeks' cover flagged for air-freight review. Planning lead times stretched on all sea lanes. Port community system alerts subscribed.",
            "scenario_id": "port_congestion",
            "alert_channels_notified": {"in_app": True, "email": True, "sms": False, "slack": True},
            "recurrence_count": 1,
            "created_at": (now - timedelta(hours=6)).isoformat(),
            "updated_at": (now - timedelta(minutes=30)).isoformat()},)

        # ── Knock-on: containers sitting at berth still have to be hauled once freed,
        # and demurrage/detention lands on freight spend well before the stockout does.

    # ── Scenario H: Cyber Incident at 3PL WMS ────────────────────────────────

    def _scenario_cyber_incident(self):
        s = self._snapshot
        now = datetime.now(timezone.utc)

        # WMS down at Leicester — manual picking only, visibility degraded
        for wh in s["warehouse_status"]:
            if wh["code"] == "LEI_COE":
                wh["throughput_vs_baseline_pct"] = 31.5
                wh["items_per_hour"] = round(wh["baseline_items_per_hour"] * 0.315)
                wh["is_disrupted"] = True
                wh["courier_ot_rate"] = 64.0
                wh["throughput_chart"] = [
                    {"hour": h, "items_per_hour": round(wh["baseline_items_per_hour"] * (0.9 if h < 9 else 0.31) * self._hourly_factor(h))}
                    for h in range(24)
                ]

        # Locker telemetry feed lost — stale statuses
        for i, locker in enumerate(s["locker_status"]):
            if i % 4 == 0:
                locker["status"] = "alert"
                locker["pre_8am_delivered"] = False

        s["kpis"]["pre_8am_success_rate"] = {"value": 61.0, "target": 95.0, "unit": "pct", "rag": "R"}
        s["kpis"]["first_time_fix_rate"] = {"value": 68.0, "target": 82.0, "unit": "pct", "rag": "R"}

        # Smart meter commissioning relies on the same integration layer — failures spike
        sm = s.get("smart_meter_status", {})
        if sm:
            sm["commissioning_failures_7d"] = sm.get("commissioning_failures_7d", 30) + 140

        self._exception_counter += 1
        s["exceptions"].insert(0, {
            "exception_code": f"EXC-CYBER-P1-{self._exception_counter:04d}",
            "priority": "P1",
            "category": "cyber_incident",
            "title": "Ransomware at TVS SCS – Leicester WMS Offline, Manual Picking Only",
            "description": (
                "TVS SCS reports a ransomware event on the Leicester NDC warehouse management system. "
                "Automated picking, ASN feeds and locker telemetry are offline. Throughput at 31% on manual processes. "
                "No evidence of ABC data exfiltration. Incident response underway with NCSC notified."
            ),
            "impacted_engineer_count": 300,
            "impacted_skus": [],
            "estimated_resolution_hours": 72,
            "recommended_action": "Shift picking to the Coventry overflow hub. Switch to paper pick lists and hourly stock reconciliation. Isolate EDI links.",
            "status": "open",
            "automated_action_taken": "Affected WMS systems isolated and automated inventory postings frozen to stop corrupt data propagating. Site switched to manual pick-and-despatch fallback. EDI to LEI_COE suspended; IT security bridge opened.",
            "scenario_id": "cyber_incident",
            "alert_channels_notified": {"in_app": True, "email": True, "sms": True, "slack": True},
            "recurrence_count": 1,
            "created_at": (now - timedelta(hours=2)).isoformat(),
            "updated_at": (now - timedelta(minutes=10)).isoformat()},)

        # ── Knock-on: a WMS outage strands stock rather than consuming it. Nothing
        # can be picked or despatched at the affected site, inventory accuracy drifts
        # while manual counts run, and the dispatch/TMS link degrades with it.
        # (Ace Hardware 2023 and the Blue Yonder attack on Morrisons both forced
        # exactly this fallback to manual warehouse processes.)
        s["executive_kpis"]["inventory_accuracy_pct"] = {
            "value": 84.3, "target": 98, "unit": "pct", "rag": "R", "trend": "down"}
        for it in s.get("inventory_positions", []):
            # Available stock is physically present but not electronically pickable
            reserved = it.get("quantity_reserved") or 0
            it["quantity_reserved"] = min(it.get("quantity_on_hand") or 0, round(reserved + (it.get("quantity_available") or 0) * 0.55))
            it["wms_locked"] = True
        self._recompute_inventory_dos()
        self._impact_field(van_stock_low_pct=28)

    # ── Scenario I: Fuel Crisis ──────────────────────────────────────────────

    def _scenario_fuel_crisis(self):
        s = self._snapshot
        now = datetime.now(timezone.utc)

        # Forecourt shortages: couriers degraded, expediting up
        for wh in s["warehouse_status"]:
            wh["courier_ot_rate"] = round(rnd(68, 78), 1)

        s["kpis"]["expediting_cost_pct"] = {"value": 6.4, "target": 3.0, "unit": "pct", "rag": "R"}
        s["kpis"]["pre_8am_success_rate"] = {"value": 78.0, "target": 95.0, "unit": "pct", "rag": "A"}

        # ~90 engineers flagged for fuel-driven route curtailment
        flagged = 0
        for i, eng in enumerate(s["engineer_locations"]):
            if flagged < 90 and i % 2 == 0:
                eng["pending_alerts"] = list(set(eng.get("pending_alerts", []) + ["fuel_priority_routing"]))
                flagged += 1

        self._exception_counter += 1
        s["exceptions"].insert(0, {
            "exception_code": f"EXC-FUEL-P2-{self._exception_counter:04d}",
            "priority": "P2",
            "category": "transport_disruption",
            "title": "National Fuel Supply Disruption – 14 Vans Grounded, Routes Curtailed",
            "description": (
                "Forecourt fuel shortages across the Midlands and South East. 14 diesel vans grounded awaiting "
                "depot fuel allocation. Route optimizer switched to fuel-priority mode — non-urgent jobs deferred. "
                "EV fleet unaffected and prioritised for emergency callouts."
            ),
            "impacted_engineer_count": 90,
            "impacted_skus": [],
            "estimated_resolution_hours": 96,
            "recommended_action": "Enact bunkered-fuel agreement with 3PL. Prioritise EV vans for P1 jobs. Defer annual services 72h.",
            "status": "open",
            "automated_action_taken": "Fuel allocation prioritised to P1, vulnerable-customer and safety-critical jobs. Routes consolidated and non-essential mileage deferred. EV vans re-ranked to the top of the dispatch queue.",
            "scenario_id": "fuel_crisis",
            "alert_channels_notified": {"in_app": True, "email": True, "sms": False, "slack": True},
            "recurrence_count": 1,
            "created_at": (now - timedelta(hours=8)).isoformat(),
            "updated_at": (now - timedelta(hours=1)).isoformat()},)

        # ── Knock-on: a fuel crisis IS a transport event. Vans queue for diesel,
        # routes are consolidated, and non-essential mileage is cut.
        self._impact_field(off_duty_pct=9, van_stock_low_pct=18)

    # ── Low-level risk scenarios (P3/P4 — routine operational friction) ──────

    def _scenario_locker_outage(self):
        """P3: ByBox comms outage — ~40 North West lockers offline."""
        s = self._snapshot
        now = datetime.now(timezone.utc)
        affected = 0
        for locker in s["locker_status"]:
            if locker.get("region") == "North West" and affected < 40:
                locker["status"] = "alert"
                locker["pre_8am_delivered"] = False
                # It is the CONFIRMATION that failed, not the delivery — which is
                # precisely why master-key fallback is the playbook's first move,
                # so the miss queue has to say so.
                locker["miss_reason"] = "comms_loss"
                locker["miss_status"] = "open"
                locker["miss_resolution"] = None
                affected += 1
        s["kpis"]["pre_8am_success_rate"] = self._kpi(88.4, 95, "pct")
        s["lockers_healthy_pct"] = rnd(84, 88)
        self._exception_counter += 1
        s["exceptions"].insert(0, {
            "exception_code": f"EXC-LOCK-P3-{self._exception_counter:04d}",
            "priority": "P3",
            "category": "locker_failure",
            "title": f"ByBox Comms Outage – {affected} North West Lockers Offline",
            "description": (
                f"A ByBox network fault has taken {affected} locker sites offline in the North West. "
                "Door telemetry and remote unlock are unavailable; tonight's pre-8AM wave cannot be confirmed "
                "for affected sites. Engineers can fall back to master-key access."
            ),
            "impacted_engineer_count": 55,
            "impacted_skus": [],
            "estimated_resolution_hours": 6,
            "recommended_action": "Issue master-key fallback notice to affected engineers. Divert tonight's pre-8AM wave to nearest healthy sites.",
            "status": "open",
            "automated_action_taken": "Master-key fallback pushed to affected engineers with the three nearest healthy sites. Tonight's pre-8AM wave diverted to adjacent lockers. ByBox NOC ticket raised; automated routing held until sites confirm recovered.",
            "scenario_id": "locker_outage",
            "alert_channels_notified": {"in_app": True, "email": True, "sms": False, "slack": False},
            "recurrence_count": 1,
            "created_at": (now - timedelta(hours=1)).isoformat(),
            "updated_at": (now - timedelta(minutes=15)).isoformat()},)

    def _scenario_courier_shortage(self):
        """P3: agency courier no-show at Manchester — replenishment slips."""
        s = self._snapshot
        now = datetime.now(timezone.utc)
        for wh in s["warehouse_status"]:
            if wh["code"] == "MAN_HUB":
                wh["throughput_vs_baseline_pct"] = 76.0
                wh["items_per_hour"] = round(wh["baseline_items_per_hour"] * 0.76)
                wh["courier_ot_rate"] = 74.5
        s["kpis"]["expediting_cost_pct"] = self._kpi(3.4, 3.0, "pct", lower_better=True)
        delayed = 0
        for sh in s["shipments"]:
            if delayed < 3 and sh["status"] == "in_transit":
                sh["status"] = "delayed"
                sh["delay_hours"] = round(rnd(2, 5), 1)
                sh["alert_raised"] = sh["delay_hours"] > 4
                delayed += 1
        self._exception_counter += 1
        s["exceptions"].insert(0, {
            "exception_code": f"EXC-COUR-P3-{self._exception_counter:04d}",
            "priority": "P3",
            "category": "transport_disruption",
            "title": "Agency Courier No-Show – Manchester Hub Replenishment Slipping",
            "description": (
                "The overnight agency courier crew (6 drivers) failed to report at Manchester Hub. "
                "Courier on-time rate has dropped to 74.5% and three inbound trunk moves are running 2–5h late. "
                "Van replenishment for the North West morning wave is at risk."
            ),
            "impacted_engineer_count": 40,
            "impacted_skus": [],
            "estimated_resolution_hours": 12,
            "recommended_action": "Call off standby courier contract. Prioritise van-stock-low engineers in tonight's reduced run.",
            "status": "open",
            "automated_action_taken": "Standby courier contract called off for the affected shift. Replenishment run re-sequenced by van-stock severity and affected engineers notified. No-show logged against the agency SLA.",
            "scenario_id": "courier_shortage",
            "alert_channels_notified": {"in_app": True, "email": True, "sms": False, "slack": True},
            "recurrence_count": 2,
            "created_at": (now - timedelta(hours=3)).isoformat(),
            "updated_at": (now - timedelta(minutes=40)).isoformat()},)

        # ── Knock-on: fewer courier crews means the trunk moves that feed the hubs
        # run late, so on-time delivery and transit exceptions move with it.
        self._impact_field(van_stock_low_pct=22)

    def _scenario_supplier_otif_dip(self):
        """P4: single supplier OTIF drifts below target — watch-list item."""
        s = self._snapshot
        now = datetime.now(timezone.utc)
        for supplier in s["supplier_scorecards"]:
            if supplier["supplier_code"] == "SAM_HA":
                supplier["otif_score"] = 78.2
                supplier["composite_risk_score"] = 58
                supplier["sedex_risk_level"] = "medium"
        s["kpis"]["supplier_otif"] = self._kpi(89.6, 92, "pct")
        self._exception_counter += 1
        s["exceptions"].insert(0, {
            "exception_code": f"EXC-OTIF-P4-{self._exception_counter:04d}",
            "priority": "P4",
            "category": "supplier_risk",
            "title": "Samsung HA OTIF at 78% – 2nd Consecutive Week Below Target",
            "description": (
                "SAM_HA on-time-in-full has slipped to 78.2% for the second consecutive week (target 92%). "
                "No immediate supply risk — heat pump cover remains above lead time — but the trend "
                "warrants a capacity conversation before winter demand builds."
            ),
            "impacted_engineer_count": 0,
            "impacted_skus": ["SKU-HP-002"],
            "estimated_resolution_hours": 336,
            "recommended_action": "Request weekly capacity confirmation from SAM_HA. Review open PO delivery promises.",
            "status": "open",
            "automated_action_taken": "OTIF watch-list entry created. Account manager briefed via email digest.",
            "scenario_id": "supplier_otif_dip",
            "alert_channels_notified": {"in_app": True, "email": False, "sms": False, "slack": False},
            "recurrence_count": 2,
            "created_at": (now - timedelta(hours=20)).isoformat(),
            "updated_at": (now - timedelta(hours=4)).isoformat()},)

    # ─────────────────────────────────────────────
    # MUTATION METHODS (called by routers)
    # ─────────────────────────────────────────────

    def get_snapshot(self) -> dict:
        if not self._initialized:
            self.initialize()
        # Ensure the multi-agent layer is present even when an older persisted
        # snapshot (without it) is loaded — no regeneration needed.
        if "agent_layer" not in self._snapshot:
            self._snapshot["agent_layer"] = self._gen_agent_layer()
        return self._snapshot

    async def tick(self):
        """The heartbeat. Fires every `cadence.TICK_INTERVAL_S` seconds, but each
        parameter family only moves when ITS OWN interval has elapsed — a van
        telematics ping and a supplier OTIF scorecard do not update at the same
        rate in any real network, and pretending they do makes both look wrong.

        Entities somebody has just acted on are additionally held (see
        `hold_entity`) so a resolution's impact survives long enough to be seen
        instead of being randomised away on the next pass.

        This is `async def` for a reason, and it must stay that way. APScheduler's
        AsyncIOExecutor runs coroutine jobs directly on the event loop and hands
        every *non*-coroutine to `run_in_executor` — a threadpool thread. As a
        plain `def`, this method rewrote `_snapshot` from that thread while request
        handlers were serialising the very same dicts, because `get_snapshot()`
        returns the live object by reference and nothing here takes a lock. That
        raised `RuntimeError: dictionary changed size during iteration` whenever a
        tick popped a key mid-response (e.g. `refresh_locker_misses` dropping
        `miss_reason`), and silently duplicated or skipped items on the list
        families, which `.insert(0, …)` mutates in place.

        On the loop there is no preemption: this body contains no `await`, so it
        runs to completion as one atomic step relative to every handler. That is
        what makes the whole lock-free design safe. Do not add an `await` inside
        the mutation section — an await point here reintroduces exactly the
        interleaving this change removed.
        """
        if not self._initialized:
            return
        s = self._snapshot
        now = datetime.now(timezone.utc)
        self._tick_seq += 1
        s["last_refresh"] = now.isoformat()

        # Look up scenario-appropriate ranges (falls back to normal if unknown scenario)
        ranges = SCENARIO_TICK_RANGES.get(self._active_scenario or "normal", SCENARIO_TICK_RANGES["normal"])
        wh_ranges = ranges["warehouses"]
        uplift_lo, uplift_hi = ranges["demand_uplift"]

        # ── Warehouse throughput · 5 min (WMS rollup) ────────────────────────
        # throughput_vs_baseline_pct is daytime-relative; no hourly factor applied to the pct
        # (that factor only drives throughput_chart in the initial build, not the live KPI).
        if self._feed_due("warehouse_throughput"):
            for wh in s.get("warehouse_status", []):
                if self.is_held("warehouse", wh["code"]):
                    continue
                baseline = next((w["baseline_items_per_hour"] for w in WAREHOUSES_DATA if w["code"] == wh["code"]), 2000)
                lo, hi = wh_ranges.get(wh["code"], (85, 105))
                pct = rnd(lo, hi)
                wh["items_per_hour"] = round(baseline * pct / 100)
                wh["throughput_vs_baseline_pct"] = round(pct, 1)
                wh["is_disrupted"] = pct < 40
                # Courier OT degrades in proportion to throughput range floor
                if lo >= 80:
                    wh["courier_ot_rate"] = rnd(93, 98)
                elif lo >= 50:
                    wh["courier_ot_rate"] = rnd(80, 92)
                else:
                    wh["courier_ot_rate"] = rnd(52, 78)

        # ── KPIs · 5 min, demand signals · 10 min ────────────────────────────
        # Regenerate freely in normal state; keep KPIs frozen during scenarios
        # (they're set to precise scenario values) but nudge demand uplift
        # slightly so inventory DoS feels live.
        if not self._active_scenario:
            if self._feed_due("kpis"):
                s["kpis"] = self._gen_kpis()
            if self._feed_due("demand_signals"):
                s["demand_signals"] = self._gen_demand_signals()
        elif self._feed_due("demand_signals"):
            # Scenario active: the scenario has already staged the driver signals
            # (e.g. Beast from the East sets HDD 168 and condensate risk). Demand
            # is sensed from those REAL drivers now, so breathe them ±3% around
            # the staged values rather than overwriting them — and keep the legacy
            # uplift scalar ticking for anything still displaying it.
            ds = s.get("demand_signals", {})
            weather = ds.get("weather", {})
            weather["demand_uplift_factor"] = round(rnd(uplift_lo, uplift_hi), 2)
            # Anchor on the values the scenario staged (captured once per scenario)
            # so the breathing never random-walks away from the scenario's intent.
            if getattr(self, "_staged_signal_anchor_for", None) != self._active_scenario:
                self._staged_signal_anchor_for = self._active_scenario
                self._staged_signal_anchor = {
                    "hdd": weather.get("heating_degree_days_7d"),
                    "hive": ds.get("hive_faults", {}).get("high_probability_signals_24h"),
                    "lockouts": ds.get("hive_faults", {}).get("condensate_lockout_signals_24h")}
            anchor = self._staged_signal_anchor
            if isinstance(anchor.get("hdd"), (int, float)):
                weather["heating_degree_days_7d"] = round(anchor["hdd"] * rnd(0.97, 1.03, 3), 1)
            hive = ds.get("hive_faults", {})
            for key, field in (("hive", "high_probability_signals_24h"), ("lockouts", "condensate_lockout_signals_24h")):
                if isinstance(anchor.get(key), (int, float)):
                    hive[field] = max(0, round(anchor[key] * rnd(0.97, 1.03, 3)))

        # ── Engineer positions · 30s (telematics ping) ───────────────────────
        # The fastest feed in the network, and the one an operator judges
        # "is this live?" by. It runs on every heartbeat, scenario or not.
        if self._feed_due("engineer_positions"):
            for eng in s.get("engineer_locations", []):
                region = eng.get("region", "East Midlands")
                lat_c, lon_c = self._REGION_CENTRES.get(region, (52.5, -1.5))
                eng["latitude"] = round(max(lat_c - 0.22, min(lat_c + 0.22, eng["latitude"] + rnd(-0.002, 0.002, 4))), 4)
                eng["longitude"] = round(max(lon_c - 0.22, min(lon_c + 0.22, eng["longitude"] + rnd(-0.002, 0.002, 4))), 4)
            s["active_engineer_count"] = len([e for e in s["engineer_locations"] if e["job_status"] != "off_duty"])
            # The telematics units ride the same ping. Without this the IoT
            # estate's "minutes since last ping" would be frozen at whatever the
            # baseline drew and never move — a staleness measure that is itself
            # permanently stale, which is worse than not showing one.
            self._drift_van_telematics(s)

        # ── Van stock · 15 min (scan-driven) ─────────────────────────────────
        # Parts leave the van when they are fitted, so the level only moves a
        # few times an hour — and a van somebody has just resolved is held.
        if self._feed_due("van_stock"):
            self._drift_van_stock()
            self.refresh_van_stock_alerts()

        # ── Locker telemetry · 15 min (ByBox heartbeat) ──────────────────────
        if self._feed_due("locker_telemetry"):
            self._drift_lockers()
            self.refresh_locker_misses()

        # ── Third-party carrier tracking · 5 min (EDI scan events) ───────────
        if self._feed_due("carrier_tracking"):
            self.advance_carrier_movements()

        # ── Route progress & arrival risk · 2 min ────────────────────────────
        if self._feed_due("route_progress"):
            self.refresh_route_eta_risk()

        # ── Fleet compliance & driver scores · 1 h (daily records) ───────────
        if self._feed_due("fleet_compliance"):
            self._drift_fleet_compliance()

        # ── Planning · 30 min (net-change MRP) ───────────────────────────────
        if self._feed_due("inventory_planning"):
            self._recompute_inventory_dos()  # propagate demand uplift to inventory metrics
            # NDC echelon (supplier POs) is raised by ATLAS's governed autonomy
            # cycle, not here — see the note above `_AUTO_TRANSFER_MAX_PER_TICK`.
            self.auto_rebalance_hub_transfers()  # hub echelon: hubs raise STOs on the NDC

        # ── Stock transfer lifecycle · 15 min (physical milestones) ──────────
        if self._feed_due("sto_lifecycle"):
            self.advance_sto_lifecycle()     # walk open STOs: requested → picking → in transit → received

        # Derived analytics are cheap and must never lag the state they describe,
        # so they recompute on every heartbeat rather than on their own clock.
        self._sync_derived_state()

    # ── Per-family drift helpers ─────────────────────────────────────────────
    # Each one respects the hold: an entity a human or ATLAS has just acted on
    # is left exactly as they left it until the hold expires.

    def _drift_van_stock(self) -> None:
        """A handful of parts get consumed or received across the fleet each
        cycle — not every van, every time, which is what made the old blanket
        refresh feel synthetic."""
        engineers = self._snapshot.get("engineer_locations", [])
        if not engineers:
            return
        working = [e for e in engineers
                   if e.get("job_status") in ("en_route", "on_site")
                   and not self.is_held("engineer", e["engineer_code"])]
        for eng in random.sample(working, k=min(len(working), max(1, len(engineers) // 25))):
            items = eng.get("van_stock_items") or []
            if not items:
                continue
            it = random.choice(items)
            # Consumption is the common case; the odd van receives a top-up.
            delta = -1 if random.random() < 0.78 else 1
            it["quantity"] = max(0, (it.get("quantity") or 0) + delta)
            it["is_below_min"] = (it["quantity"] or 0) < (it.get("min_quantity") or 0)
            eng["van_stock_low"] = any(i.get("is_below_min") for i in items)

    def _drift_lockers(self) -> None:
        """Fill level breathes as engineers collect and the wave lands. The
        pre-8AM result itself is a once-a-day outcome, so it only flips for a
        small number of sites per cycle."""
        lockers = self._snapshot.get("locker_status", [])
        for l in lockers:
            if self.is_held("locker", l.get("bybox_site_code")):
                continue
            l["fill_pct"] = round(max(5.0, min(99.0, (l.get("fill_pct") or 50) + rnd(-6, 6))), 1)
            if random.random() < 0.01:
                l["pre_8am_delivered"] = not l.get("pre_8am_delivered")
            l["status"] = "alert" if ((l["fill_pct"] > 85) or not l.get("pre_8am_delivered")) else "healthy"

    def _drift_fleet_compliance(self) -> None:
        """MOT countdowns, walkaround sign-offs and behaviour scores are daily
        records — they move once an hour here, and only by a little."""
        for v in self._snapshot.get("fleet_vehicles", []):
            if self.is_held("vehicle", v.get("registration")):
                continue
            if not v.get("walkaround_completed") and random.random() < 0.10:
                v["walkaround_completed"] = True
                v["walkaround_time"] = datetime.now(timezone.utc).strftime("%H:%M")
            v["driver_score"] = max(50, min(99, (v.get("driver_score") or 80) + random.randint(-1, 1)))
            v["hours_driven_today"] = round(min(9.5, (v.get("hours_driven_today") or 0) + rnd(0.1, 0.4)), 1)
            v["miles_today"] = (v.get("miles_today") or 0) + random.randint(1, 6)

    def generate_forecast(self, sku_code: str, horizon: int) -> dict:
        """Driver-based forecast. A base demand rate is shaped by category
        seasonality and by the live demand signals that actually move this SKU,
        and returned WITH its decomposition — so every unit of the forecast can be
        traced back to a driver (base → +seasonality → +weather → +IoT → +grants).
        The old model was daily × horizon × noise; this one is causal."""
        signals = self._snapshot.get("demand_signals", {}) if self._initialized else {}
        cfg = SKU_CONFIG.get(sku_code, {})
        cat = SKU_CATEGORY.get(sku_code, "boiler")
        item = next((i for i in self._snapshot.get("inventory_positions", []) if i["sku_code"] == sku_code), None)
        daily_base = cfg.get("daily_consumption", 10)
        mape = ((item or {}).get("forecast_quality") or {}).get("mape_pct", 14.0)

        base_units = daily_base * horizon
        season_avg = self._horizon_seasonality(cat, horizon)
        season_units = round(base_units * (season_avg - 1.0))

        # ── Layer 1: BASELINE (statistical) — level × seasonality. Valid at any horizon.
        baseline_units = max(0, round(base_units + season_units))

        # ── Layer 2: DEMAND SENSING — weather + IoT, weighted so the signal fades
        # as the forecast horizon outruns the reliability of the signals it rides on.
        scores = _driver_scores(signals)
        sensing_weight = _horizon_sensing_weight(horizon)
        groups = {"weather": 0.0, "iot": 0.0}
        for key, drv in DEMAND_DRIVERS.items():
            if cat in drv["categories"]:
                groups[drv["group"]] = groups.get(drv["group"], 0.0) + scores.get(key, 0.0)
        group_units = {g: round(base_units * sc * sensing_weight) for g, sc in groups.items()}
        sensing_units = sum(group_units.values())

        total = max(0, round(baseline_units + sensing_units))

        GROUP_LABEL = {"weather": "Weather (HDD / cold snap)", "iot": "Hive IoT faults"}
        decomposition = [{"driver": "base", "label": "Base demand", "group": "base", "units": base_units}]
        if season_units:
            decomposition.append({"driver": "seasonality", "label": f"Seasonality ({cat.replace('_', ' ')})",
                                  "group": "seasonality", "units": season_units})
        for g in ("weather", "iot"):
            if group_units.get(g):
                decomposition.append({"driver": g, "label": GROUP_LABEL[g], "group": g, "units": group_units[g]})

        # One continuous series: 30 days of actuals, a bridge point at today, then
        # the forward forecast with a confidence band that widens with horizon.
        today = datetime.now(timezone.utc).date()
        # Same signal multiplier the forecast carries, so history and forecast are level
        hist_mult, _ = _sku_demand_multiplier(sku_code, signals)
        history = self._sku_daily_history(sku_code, 30, hist_mult)
        last_actual = history[-1]["actual"] if history else daily_base
        series = list(history)
        series.append({"day": 0, "date": today.isoformat(), "label": "today",
                       "actual": last_actual, "forecast": last_actual,
                       "lower": last_actual, "upper": last_actual})
        # Forward series: baseline every day, with the sensing layer decaying out.
        base_per_day = baseline_units / horizon if horizon else 0
        sensing_rate = (sum(groups.values()) * base_units / horizon) if horizon else 0
        for k in range(1, horizon + 1):
            d = today + timedelta(days=k)
            wd = 0.55 if d.weekday() >= 5 else 1.12
            w = _sensing_weight(k)
            baseline_day = base_per_day * wd
            qty = max(0, round(baseline_day + sensing_rate * wd * w))
            spread = (mape / 100.0) * (0.6 + 0.9 * (k / horizon))
            series.append({"day": k, "date": d.isoformat(), "forecast": qty,
                           "baseline": max(0, round(baseline_day)),
                           "sensing_weight": w,
                           "lower": max(0, round(qty * (1 - spread))), "upper": round(qty * (1 + spread))})

        band = total * (mape / 100.0)
        actual_30d = sum(h["actual"] for h in history)
        return {
            "sku_code": sku_code,
            "horizon_days": horizon,
            "history_days": len(history),
            "forecasted_qty": total,
            "actual_30d_qty": actual_30d,
            "vs_last_30d_pct": round((total / actual_30d - 1) * 100, 1) if actual_30d else None,
            "base_qty": base_units,
            # Two-layer model: statistical baseline + short-horizon sensing overlay
            "baseline_qty": baseline_units,
            "sensing_qty": sensing_units,
            "sensing_lift_pct": round(sensing_units / baseline_units * 100, 1) if baseline_units else 0.0,
            "sensing_weight_avg": sensing_weight,
            "sensing_full_days": SENSING_FULL_DAYS,
            "sensing_zero_days": SENSING_ZERO_DAYS,
            "confidence_lower_qty": max(0, round(total - band)),
            "confidence_upper_qty": round(total + band),
            "accuracy_pct": round(100 - mape, 1),
            "mape_pct": round(mape, 1),
            "seasonality_factor": round(season_avg, 3),
            "weather_uplift_factor": (item or {}).get("demand_uplift_applied", 1.0),
            "daily_consumption_adjusted": (item or {}).get("daily_consumption_adjusted", daily_base),
            "decomposition": decomposition,
            "signals_used": {"base": True, "seasonality": True, "weather": True, "hive_iot": True},
            "chart_data": series}

    @staticmethod
    def _stable_seed(text: str) -> int:
        """Process-independent seed (Python's hash() is salted per process)."""
        return sum((i + 1) * ord(ch) for i, ch in enumerate(text)) & 0x7FFFFFFF

    def _sku_daily_history(self, sku_code: str, days: int = 30, demand_mult: float = 1.0) -> list:
        """Deterministic actual-consumption history, generated from the SAME causal
        model as the forecast (base × seasonality × weather/IoT × weekday) so the two
        halves of the chart sit on one continuous level with no artificial step at
        today. Seeded per SKU, so it is stable across polls and restarts."""
        cfg = SKU_CONFIG.get(sku_code, {})
        daily_base = cfg.get("daily_consumption", 10)
        cv = cfg.get("demand_cv", 0.4)
        curve = _SEASONALITY.get(SKU_CATEGORY.get(sku_code, "boiler"), [1.0] * 12)
        rng = random.Random(self._stable_seed(sku_code))
        today = datetime.now(timezone.utc).date()
        out = []
        for k in range(days, 0, -1):
            d = today - timedelta(days=k)
            wd = 0.55 if d.weekday() >= 5 else 1.12
            noise = max(0.15, rng.gauss(1.0, min(0.45, cv * 0.6)))
            out.append({"day": -k, "date": d.isoformat(),
                        "actual": max(0, round(daily_base * curve[d.month - 1] * demand_mult * wd * noise))})
        return out

    def _horizon_seasonality(self, category: str, horizon: int) -> float:
        """Average category seasonal factor over the forward horizon."""
        curve = _SEASONALITY.get(category, [1.0] * 12)
        start = datetime.now(timezone.utc).month - 1
        months = max(1, round(horizon / 30))
        return sum(curve[(start + m) % 12] for m in range(months)) / months

    def generate_waterfall(self, sku_code: str) -> dict:
        item = next((i for i in self._snapshot.get("inventory_positions", []) if i["sku_code"] == sku_code), None)
        if item:
            return {
                "sku_code": sku_code,
                "current_stock": item["quantity_on_hand"],
                "safety_floor": item["safety_stock_level"],
                "reorder_point": item["reorder_point"],
                "forecast_30d": round(item["daily_consumption_adjusted"] * 30),
                "days_of_supply": item["days_of_supply"],
                "rag_status": item["rag_status"]}
        cfg = SKU_CONFIG.get(sku_code, {"daily_consumption": 10, "safety_stock": 100})
        on_hand = random.randint(0, 800)
        safety = cfg["safety_stock"]
        return {
            "sku_code": sku_code,
            "current_stock": on_hand,
            "safety_floor": safety,
            "reorder_point": safety + cfg["daily_consumption"] * 14,
            "forecast_30d": cfg["daily_consumption"] * 30,
            "days_of_supply": round(on_hand / max(1, cfg["daily_consumption"]), 1),
            "rag_status": "R" if on_hand == 0 else ("A" if on_hand < safety else "G")}

    def get_engineer_jobs(self, engineer_code: str) -> list:
        job_types = ["boiler_service", "boiler_replacement", "heat_pump_install", "smart_meter", "ev_charger"]
        jobs = []
        for i in range(random.randint(3, 5)):
            jtype = random.choices(job_types, weights=[45, 25, 10, 15, 5])[0]
            brand = random.choice(BOILER_BRANDS)
            jobs.append({
                "job_code": f"JOB-{engineer_code}-{100 + i}",
                "job_type": jtype,
                "property_postcode": rand_postcode(),
                "scheduled_start": (datetime.now(timezone.utc).replace(hour=8 + i * 2)).isoformat(),
                "status": random.choice(["scheduled", "en_route", "in_progress", "completed"]),
                "parts_status": random.choice(["pre_positioned", "collected", "pending"]),
                "boiler_brand": brand if "boiler" in jtype else None,
                "locker_site_code": f"BBX-0{random.randint(1000, 1100):05d}" if random.random() > 0.4 else None},)
        return jobs

    def unlock_locker(self, engineer_code: str, locker_site_code: str, sku_codes: list) -> dict:
        return {
            "unlock_initiated": True,
            "locker_site_code": locker_site_code,
            "engineer_code": engineer_code,
            "items": sku_codes,
            "bluetooth_challenge": uuid.uuid4().hex[:16].upper(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}

    def recommend_delivery_mode(self, sku_code: str, job_code: str, urgency: str) -> dict:
        modes = ["locker", "in_boot", "counter", "van_stock"]
        weights = [0.5, 0.3, 0.15, 0.05] if urgency == "normal" else [0.2, 0.1, 0.6, 0.1]
        mode = random.choices(modes, weights=weights)[0]
        return {
            "recommended_mode": mode,
            "locker_site": f"BBX-0{random.randint(1000, 1100):05d}" if mode == "locker" else None,
            "cutoff_time": "17:30" if mode == "locker" else None,
            "estimated_impact_on_schedule": "No delay" if mode in ["locker", "in_boot"] else "+45 min",
            "urgency": urgency}

    def request_transfer(self, data: dict) -> dict:
        self._transfer_counter += 1
        return {
            "transfer_id": f"TRF-{2026000 + self._transfer_counter}",
            "requesting_engineer": data["requesting_engineer_code"],
            "nearest_surplus_engineer": rand_engineer_code(),
            "meeting_point_suggestion": rand_postcode(),
            "status": "pending_approval",
            "sku_code": data["sku_code"],
            "quantity": data["quantity"]}

    def approve_transfer(self, transfer_id: str, approved_by: str, meeting_point: str | None) -> dict:
        return {"transfer_id": transfer_id, "status": "approved", "approved_by": approved_by,
                "meeting_point": meeting_point, "notifications_sent": True}

    def find_emergency_counters(self, sku_code: str, postcode: str, radius_miles: int) -> list:
        branches = ["Wolseley", "City Plumbing", "Wolseley Trade Counter"]
        return [
            {"branch": random.choice(branches), "postcode": rand_postcode(),
             "distance_miles": rnd(0.5, radius_miles),
             "quantity_available": random.randint(1, 5),
             "open_until": "18:00"}
            for _ in range(random.randint(2, 5))
        ]

    def log_decommission(self, job_code: str, data: dict) -> dict:
        return {"job_code": job_code, "logged": True, "disposal_route": data["disposal_route"],
                "collection_scheduled": True, "estimated_co2_saved_kg": rnd(8, 25)}

    def get_labour_history(self, warehouse_code: str) -> list:
        """12-week labour-risk trend for one warehouse. Older weeks sit in the
        healthy baseline band; the current week reflects live state (including
        any active scenario), so an active scenario reads as a visible spike
        against a stable history rather than an isolated number."""
        base = self._LABOUR_BASELINES.get(warehouse_code, self._LABOUR_BASELINE_DEFAULT)
        current = next((a for a in self._snapshot.get("labour_assessments", [])
                         if a["warehouse_code"] == warehouse_code), None)
        history = []
        for w in range(12):
            week = date.today() - timedelta(weeks=w)
            if w == 0 and current:
                abs_rate, trn_rate, score = current["absenteeism_rate"], current["turnover_rate"], current["risk_score"]
            else:
                abs_rate = rnd(*base["abs"])
                trn_rate = rnd(*base["trn"])
                score = self._compute_labour_risk_score(
                    abs_rate, trn_rate, rnd(*base["agency"]), rnd(*base["ot"]), "none", "none", 0, True, "none")
            history.append({
                "week_start": week.isoformat(),
                "absenteeism_rate": round(abs_rate, 1),
                "turnover_rate": round(trn_rate, 1),
                "risk_score": score},)
        return history

    def get_supplier_history(self, supplier_code: str) -> list:
        base_otif = next((s["otif_base"] for s in SUPPLIER_DATA if s["supplier_code"] == supplier_code), 88)
        history = []
        for w in range(12):
            week = date.today() - timedelta(weeks=w)
            history.append({
                "week_start": week.isoformat(),
                "otif_score": rnd(max(55, base_otif - 10), min(99, base_otif + 5))},)
        return history

    def model_scenario(self, scenario_type: str, parameters: dict) -> dict:
        duration = parameters.get("duration_days", 5)
        return {
            "scenario_type": scenario_type,
            "parameters": parameters,
            "daily_job_impact": round(rnd(0.1, 0.35) * 7200 * duration),
            "affected_engineer_count": round(rnd(0.15, 0.45) * 7200),
            "customer_breach_risk_pct": rnd(12, 68),
            "financial_cost_estimate_gbp": round(rnd(50000, 850000) * duration),
            "modelled_at": datetime.now(timezone.utc).isoformat()}

    def acknowledge_exception(self, code: str, by: str, notes: str | None) -> dict:
        for exc in self._snapshot.get("exceptions", []):
            if exc["exception_code"] == code:
                exc["status"] = "acknowledged"
                exc["acknowledged_by"] = by
                exc["acknowledged_at"] = datetime.now(timezone.utc).isoformat()
                return exc
        return {}

    @staticmethod
    def _recover(current: float, target: float, frac: float = 0.45, lower_better: bool = False) -> float:
        """Move `current` a fraction of the way toward `target`. Used to model a
        just-activated response plan as a partial, in-progress mitigation rather
        than an instant fix — mirrors real incident response, where a manual
        failover or emergency reroute recovers roughly 40-55% of lost capacity
        immediately while the rest lands as the underlying fix completes (e.g.
        parts physically arriving, a warm site reaching full throughput).
        No-ops if `current` is already at/better than `target` — a metric that
        was never actually disrupted shouldn't get nudged by an unrelated plan
        activation."""
        if lower_better:
            return current if current <= target else current - frac * (current - target)
        return current if current >= target else current + frac * (target - current)

    # Partial-recovery magnitude for each scenario's immediate response action,
    # applied once when the user activates that scenario's AI plan. Each function
    # mutates the same core-state fields its scenario handler (or, for baseline-only
    # scenarios, the ambient synthetic data) disrupted, plus registers KPI-family
    # overrides in _plan_effect_overrides so the partial recovery survives future
    # _sync_derived_state() calls instead of reverting on the next tick.
    def _compensate_p1_3pl_closure(self):
        s = self._snapshot
        for wh in s["warehouse_status"]:
            if wh["code"] == "LEI_COE":
                wh["throughput_vs_baseline_pct"] = round(self._recover(wh["throughput_vs_baseline_pct"], 100), 1)
                wh["items_per_hour"] = round(wh.get("baseline_items_per_hour", 3500) * wh["throughput_vs_baseline_pct"] / 100)
        # Trade-counter fallback restores pre-8AM delivery for roughly half the gaps
        affected = [l for l in s["locker_status"] if not l.get("pre_8am_delivered", True)]
        for locker in affected[: len(affected) // 2]:
            locker["pre_8am_delivered"] = True
            locker["status"] = "healthy"
        k = s["kpis"]
        k["first_time_fix_rate"] = self._kpi(round(self._recover(k["first_time_fix_rate"]["value"], 82), 1), 82, "pct")
        k["expediting_cost_pct"] = self._kpi(round(self._recover(k["expediting_cost_pct"]["value"], 3.0, lower_better=True), 1), 3.0, "pct", True)
        k["pre_8am_success_rate"] = self._kpi(round(self._recover(k["pre_8am_success_rate"]["value"], 95), 1), 95, "pct")
        self._plan_effect_overrides["p1_3pl_closure"] = {
            "sla_breach_add": 6.0 * 0.55, "freight_mult": self._recover(1.35, 1.0, lower_better=True), "cost_install_add": 45 * 0.55}

    def _compensate_p2_stockout(self):
        s = self._snapshot
        for item in s["inventory_positions"]:
            if item["sku_code"] == "SKU-BLR-001":
                item["quantity_on_hand"] = max(item["quantity_on_hand"], 15)
            elif item["sku_code"] == "SKU-BLR-004":
                item["quantity_on_hand"] = max(item["quantity_on_hand"], 12)
        # Inter-engineer transfers clear stock-low flags for roughly a third of vans
        low = [e for e in s["engineer_locations"] if e.get("van_stock_low")]
        for eng in low[: len(low) // 3]:
            eng["van_stock_low"] = False
        k = s["kpis"]
        k["first_time_fix_rate"] = self._kpi(round(self._recover(k["first_time_fix_rate"]["value"], 82), 1), 82, "pct")
        k["expediting_cost_pct"] = self._kpi(round(self._recover(k["expediting_cost_pct"]["value"], 3.0, lower_better=True), 1), 3.0, "pct", True)
        if "in_boot_availability" in k:
            k["in_boot_availability"] = self._kpi(round(self._recover(k["in_boot_availability"]["value"], 90), 1), 90, "pct")
        self._plan_effect_overrides["p2_stockout"] = {
            "sla_breach_add": 4.0 * 0.55, "freight_mult": self._recover(1.25, 1.0, lower_better=True), "cost_install_add": 30 * 0.55}

    def _compensate_beast_from_east(self):
        s = self._snapshot
        # Weather-safe routing mode gets some storm-damaged vans repaired/back in service
        cleared = 0
        for v in s.get("fleet_vehicles", []):
            if cleared >= 4:
                break
            defects = v.get("defects", [])
            matched = [d for d in defects if d["status"] == "open"
                       and ("seal" in d["description"].lower() or "battery" in d["description"].lower())]
            if v.get("vor") and matched:
                for d in matched:
                    d["status"] = "resolved"
                if not any(d["severity"] == "major" and d["status"] == "open" for d in defects):
                    v["vor"] = False
                cleared += 1
        self._plan_effect_overrides["beast_from_east"] = {
            "forecast_accuracy": self._recover(76.0, 88), "scope3": round(self._recover(2280, 2000, lower_better=True)),
            "freight_mult": self._recover(1.30, 1.0, lower_better=True), "fuel_mpg": self._recover(31.0, 38),
            "cost_install_add": 25 * 0.55, "sla_breach_add": 3.0 * 0.55}

    def _compensate_supplier_insolvency(self):
        s = self._snapshot
        # Contingency PO with Daikin/Samsung confirmed — but insolvency itself is a
        # long-lead-time issue (18wk contingency lead), so this is deliberately a
        # small immediate nudge, not a fast recovery.
        for po in s["purchase_orders"]:
            if po.get("po_type") == "contingency" and po.get("status") == "draft":
                po["status"] = "confirmed"
        k = s["kpis"]
        if "supplier_otif" in k:
            k["supplier_otif"] = self._kpi(round(self._recover(k["supplier_otif"]["value"], 92, frac=0.15), 1), 92, "pct")

    def _compensate_heat_pump_surge(self):
        s = self._snapshot
        for item in s["inventory_positions"]:
            if item["sku_code"] in ("SKU-HP-001", "SKU-HP-002"):
                item["quantity_on_hand"] = max(item["quantity_on_hand"], 11)
        k = s["kpis"]
        if "expediting_cost_pct" in k:
            k["expediting_cost_pct"] = self._kpi(round(self._recover(k["expediting_cost_pct"]["value"], 3.0, lower_better=True), 1), 3.0, "pct", True)
        self._plan_effect_overrides["heat_pump_surge"] = {"cost_install_add": 20 * 0.55}

    def _compensate_port_congestion(self):
        s = self._snapshot
        delayed = [sh for sh in s["shipments"] if sh.get("status") == "delayed" and sh.get("delay_hours", 0) > 100]
        for sh in delayed[: max(1, len(delayed) // 2)]:
            sh["delay_hours"] = round(sh["delay_hours"] * 0.55, 1)
            if sh["delay_hours"] < 48:
                sh["status"] = "in_transit"
        for code in self._heat_pump_oem_codes():
            self._set_oem_override(code, lead_time_weeks_delta=-2)
        k = s["kpis"]
        if "expediting_cost_pct" in k:
            k["expediting_cost_pct"] = self._kpi(round(self._recover(k["expediting_cost_pct"]["value"], 3.0, lower_better=True), 1), 3.0, "pct", True)
        if "supplier_otif" in k:
            k["supplier_otif"] = self._kpi(round(self._recover(k["supplier_otif"]["value"], 92), 1), 92, "pct")
        self._plan_effect_overrides["port_congestion"] = {
            "scope3": round(self._recover(2140, 2000, lower_better=True)), "freight_mult": self._recover(1.45, 1.0, lower_better=True),
            "cost_install_add": 22 * 0.55, "forecast_accuracy": self._recover(84.0, 88)}

    def _compensate_cyber_incident(self):
        s = self._snapshot
        for wh in s["warehouse_status"]:
            if wh["code"] == "LEI_COE":
                wh["throughput_vs_baseline_pct"] = round(self._recover(wh["throughput_vs_baseline_pct"], 100), 1)
                wh["items_per_hour"] = round(wh.get("baseline_items_per_hour", 3500) * wh["throughput_vs_baseline_pct"] / 100)
        affected = [l for l in s["locker_status"] if l.get("status") == "alert"]
        for locker in affected[: len(affected) // 2]:
            locker["status"] = "healthy"
            locker["pre_8am_delivered"] = True
        sm = s.get("smart_meter_status", {})
        if sm and "commissioning_failures_7d" in sm:
            sm["commissioning_failures_7d"] = max(30, sm["commissioning_failures_7d"] - 63)
        k = s["kpis"]
        if "pre_8am_success_rate" in k:
            k["pre_8am_success_rate"] = self._kpi(round(self._recover(k["pre_8am_success_rate"]["value"], 95), 1), 95, "pct")
        if "first_time_fix_rate" in k:
            k["first_time_fix_rate"] = self._kpi(round(self._recover(k["first_time_fix_rate"]["value"], 82), 1), 82, "pct")
        self._plan_effect_overrides["cyber_incident"] = {
            "inventory_accuracy": self._recover(90.8, 98), "sla_breach_add": 5.0 * 0.55, "freight_mult": self._recover(1.10, 1.0, lower_better=True)}

    def _compensate_fuel_crisis(self):
        s = self._snapshot
        cleared = 0
        for v in s.get("fleet_vehicles", []):
            if cleared >= 6:
                break
            defects = v.get("defects", [])
            matched = [d for d in defects if d["status"] == "open" and "refuel" in d["description"].lower()]
            if v.get("vor") and matched:
                for d in matched:
                    d["status"] = "resolved"
                if not any(d["severity"] == "major" and d["status"] == "open" for d in defects):
                    v["vor"] = False
                cleared += 1
        for eng in s["engineer_locations"]:
            alerts = eng.get("pending_alerts") or []
            if "fuel_priority_routing" in alerts and random.random() < 0.45:
                eng["pending_alerts"] = [a for a in alerts if a != "fuel_priority_routing"]
        k = s["kpis"]
        if "expediting_cost_pct" in k:
            k["expediting_cost_pct"] = self._kpi(round(self._recover(k["expediting_cost_pct"]["value"], 3.0, lower_better=True), 1), 3.0, "pct", True)
        if "pre_8am_success_rate" in k:
            k["pre_8am_success_rate"] = self._kpi(round(self._recover(k["pre_8am_success_rate"]["value"], 95), 1), 95, "pct")
        self._plan_effect_overrides["fuel_crisis"] = {
            "fuel_mpg": self._recover(33.0, 38), "freight_mult": self._recover(1.40, 1.0, lower_better=True), "sla_breach_add": 2.0 * 0.55}

    def _compensate_locker_outage(self):
        s = self._snapshot
        affected = [l for l in s["locker_status"] if l.get("status") == "alert" and not l.get("pre_8am_delivered", True)]
        for locker in affected[: max(1, round(len(affected) * 0.45))]:
            locker["status"] = "healthy"
            locker["pre_8am_delivered"] = True
        k = s["kpis"]
        if "pre_8am_success_rate" in k:
            k["pre_8am_success_rate"] = self._kpi(round(self._recover(k["pre_8am_success_rate"]["value"], 95), 1), 95, "pct")

    def _compensate_courier_shortage(self):
        s = self._snapshot
        for wh in s["warehouse_status"]:
            if wh["code"] == "MAN_HUB":
                wh["throughput_vs_baseline_pct"] = round(self._recover(wh["throughput_vs_baseline_pct"], 100), 1)
                wh["items_per_hour"] = round(wh.get("baseline_items_per_hour", 2000) * wh["throughput_vs_baseline_pct"] / 100)
        for sh in s["shipments"]:
            if sh.get("status") == "delayed" and sh.get("delay_hours", 0) <= 5:
                sh["delay_hours"] = round(sh["delay_hours"] * 0.55, 1)
        k = s["kpis"]
        if "expediting_cost_pct" in k:
            k["expediting_cost_pct"] = self._kpi(round(self._recover(k["expediting_cost_pct"]["value"], 3.0, lower_better=True), 1), 3.0, "pct", True)

    def _compensate_supplier_otif_dip(self):
        s = self._snapshot
        for supplier in s["supplier_scorecards"]:
            if supplier["supplier_code"] == "SAM_HA":
                supplier["otif_score"] = round(self._recover(supplier["otif_score"], 92, frac=0.20), 1)
        k = s["kpis"]
        if "supplier_otif" in k:
            k["supplier_otif"] = self._kpi(round(self._recover(k["supplier_otif"]["value"], 92, frac=0.20), 1), 92, "pct")

    def _compensate_shipment_delay(self):
        s = self._snapshot
        # Small, localized fix — stock rerouted from Manchester Hub covers today's
        # affected jobs directly, without touching wider network KPI families.
        delayed = sorted(
            (sh for sh in s["shipments"] if sh.get("status") == "delayed"),
            key=lambda sh: sh.get("delay_hours", 0),
        )
        if delayed:
            sh = delayed[0]
            sh["delay_hours"] = round(sh["delay_hours"] * 0.5, 1)
            if sh["delay_hours"] < 4:
                sh["status"] = "in_transit"
        k = s["kpis"]
        if "in_boot_availability" in k:
            k["in_boot_availability"] = self._kpi(round(self._recover(k["in_boot_availability"]["value"], 90, frac=0.25), 1), 90, "pct")

    _PLAN_COMPENSATION = {
        "p1_3pl_closure":      _compensate_p1_3pl_closure,
        "p2_stockout":         _compensate_p2_stockout,
        "beast_from_east":     _compensate_beast_from_east,
        "supplier_insolvency": _compensate_supplier_insolvency,
        "heat_pump_surge":     _compensate_heat_pump_surge,
        "port_congestion":     _compensate_port_congestion,
        "cyber_incident":      _compensate_cyber_incident,
        "fuel_crisis":         _compensate_fuel_crisis,
        "locker_outage":       _compensate_locker_outage,
        "courier_shortage":    _compensate_courier_shortage,
        "supplier_otif_dip":   _compensate_supplier_otif_dip,
        "shipment_delay":      _compensate_shipment_delay}

    def _apply_plan_compensation(self, scenario_id: str | None):
        """Apply the scenario's grounded, partial-recovery compensatory effects
        (once) and re-derive every analytics surface so the change is visible
        immediately across Dashboard, Analytics, Transport Control etc."""
        fn = self._PLAN_COMPENSATION.get(scenario_id or "")
        if not fn:
            return
        fn(self)
        self._recompute_inventory_dos()
        self._sync_derived_state()
        self._snapshot["exceptions_summary"] = self._gen_exceptions_summary(
            self._snapshot.get("exceptions", [])
        )

    def activate_risk_plan(self, code: str, by: str) -> dict:
        """User-triggered activation of the AI-suggested Immediate response
        plan for one exception. Taking ownership of the plan implies
        acknowledgement, so an open exception also transitions in the same
        action rather than requiring a separate acknowledge step. Activation
        also triggers that scenario's real, research-grounded compensatory
        effects on the related KPIs/warehouse/inventory/fleet/supplier data —
        a partial, in-progress recovery (not an instant fix), consistent with
        how the underlying response action (reroute, emergency PO, manual
        failover) would actually play out."""
        now = datetime.now(timezone.utc).isoformat()
        for exc in self._snapshot.get("exceptions", []):
            if exc["exception_code"] == code:
                already_activated = exc.get("plan_activated", False)
                exc["plan_activated"] = True
                exc["plan_activated_by"] = by
                exc["plan_activated_at"] = now
                if exc["status"] == "open":
                    exc["status"] = "acknowledged"
                    exc["acknowledged_by"] = by
                    exc["acknowledged_at"] = now
                if not already_activated:
                    self._apply_plan_compensation(exc.get("scenario_id"))
                return exc
        return {}

    def resolve_exception(self, code: str, by: str, root_cause: str, notes: str | None) -> dict:
        for exc in self._snapshot.get("exceptions", []):
            if exc["exception_code"] == code:
                exc["status"] = "resolved"
                exc["resolved_by"] = by
                exc["resolved_at"] = datetime.now(timezone.utc).isoformat()
                exc["root_cause"] = root_cause
                return exc
        return {}

    def update_alert_rule(self, rule_code: str, updates: dict) -> dict:
        for rule in self._snapshot.get("alert_rules", []):
            if rule["rule_code"] == rule_code:
                rule.update(updates)
                return rule
        return {}

    def create_purchase_order(self, data: dict) -> dict:
        """Raise one PO, from a human on the page or from ATLAS's own hand.

        `is_auto_generated` / `auto_reason` are the provenance ATLAS attaches when
        it raises this itself under policy (`agent_engine._execute`, `by ==
        "fleet-auto"`) — never set by a human-initiated call, so the flag always
        means "the fleet did this unwatched", the same meaning the UI has shown it
        since the old scenario-only auto-raiser this replaced.
        """
        self._po_counter += 1
        now = datetime.now(timezone.utc)
        po_type = data.get("po_type", "standard")
        supplier_code = data.get("supplier_code")
        supplier_name = next(
            (s["name"] for s in SUPPLIER_DATA if s["supplier_code"] == supplier_code),
            supplier_code,
        )
        delivery_days = 2 if po_type == "emergency" else random.randint(3, 7)
        unit_cost = SKU_CONFIG.get(data.get("sku_code"), {}).get("unit_cost_gbp")
        po_value = round((data.get("quantity") or 0) * unit_cost, 2) if unit_cost else round(rnd(5000, 50000), 2)
        auto = bool(data.get("is_auto_generated"))
        po = {
            "po_number": f"PO-{2026900 + self._po_counter}",
            "sku_code": data.get("sku_code"),
            "supplier_code": supplier_code,
            "supplier_name": supplier_name,
            "warehouse_code": data.get("warehouse_code"),
            "po_type": po_type,
            "quantity": data.get("quantity"),
            "notes": data.get("notes"),
            # A human's PO starts as a draft they still have to work; ATLAS only
            # ever raises one that has already cleared every governance gate
            # (autonomy class, confidence floor, value ceiling — see
            # `agent_engine._action_auto_eligible`), so it is confirmed on arrival.
            "status": "confirmed" if auto else "draft",
            "total_value_gbp": po_value,
            "is_auto_generated": auto,
            "auto_reason": data.get("auto_reason") if auto else None,
            "ariba_checked": auto,
            "ordered_at": now.isoformat(),
            "expected_delivery": (now + timedelta(days=delivery_days)).isoformat(),
            "created_at": now.isoformat()}
        self._snapshot.setdefault("purchase_orders", []).insert(0, po)
        if auto:
            self._snapshot["auto_po_log"] = ([po] + self._snapshot.get("auto_po_log", []))[:25]
        return po

    def update_warehouse_throughput(self, data: dict):
        code = data.get("warehouse_code")
        for wh in self._snapshot.get("warehouse_status", []):
            if wh["code"] == code:
                wh["items_per_hour"] = data.get("items_per_hour", wh["items_per_hour"])
                wh["throughput_vs_baseline_pct"] = data.get("throughput_vs_baseline_pct", wh["throughput_vs_baseline_pct"])
                wh["courier_ot_rate"] = data.get("courier_ot_rate", wh["courier_ot_rate"])

    def process_dispatch_event(self, data: dict): pass
    def update_job_status(self, data: dict): pass
    def update_van_stock(self, data: dict): pass
    def confirm_locker_delivery(self, data: dict): pass
    def process_locker_collection(self, data: dict): pass
    def update_locker_status(self, data: dict): pass
    def process_boiler_signal(self, data: dict) -> dict:
        """Ingest a Hive fault signal and answer with the resulting decision.

        This used to echo a threshold check and drop the signal on the floor, so a
        device could report a fault, get told it had been pre-positioned, and never
        appear in the pipeline the page reads. The signal is now recorded, and the
        answer is the same derived decision the module shows everywhere else —
        including the case where the part is nowhere in the network and the honest
        answer is that we cannot cover it."""
        fault_type = data.get("fault_type") or "diverter_valve_failure"
        sku, part = FAULT_PART_MAP.get(fault_type, (None, None))
        region = data.get("region") or random.choice(UK_REGIONS)
        prob = float(data.get("fault_probability") or 0)

        signal = {
            "device_id": data.get("device_id") or f"HIVE-{uuid.uuid4().hex[:8].upper()}",
            "property_postcode": data.get("postcode") or rand_postcode(region),
            "region": region,
            "boiler_brand": data.get("boiler_brand") or random.choice(BOILER_BRANDS),
            "boiler_model": data.get("boiler_model") or "Unknown",
            "boiler_age_years": data.get("age_years"),
            "fault_type": fault_type,
            "required_sku": sku,
            "required_part": part,
            "fault_probability": prob,
            "replacement_probability_90d": data.get("replacement_probability_90d", round(prob * 0.7, 4)),
            "signal_timestamp": datetime.now(timezone.utc).isoformat(),
            "ingested": True}

        pipeline = self.get_snapshot().setdefault("boiler_fault_pipeline", [])
        # One row per device — a boiler re-reporting the same fault is an update,
        # not a second job.
        for i, existing in enumerate(pipeline):
            if existing.get("device_id") == signal["device_id"]:
                pipeline[i] = signal
                break
        else:
            pipeline.insert(0, signal)

        decided = next((f for f in self.get_fault_pipeline()
                        if f.get("device_id") == signal["device_id"]), None)
        return {
            "device_id": signal["device_id"],
            "required_part": part,
            "parts_cover": decided.get("parts_cover") if decided else "none",
            "cover_detail": decided.get("cover_detail") if decided else None,
            "pre_positioning_triggered": bool(decided and decided.get("pre_positioning_triggered")),
            "pre_positioning_blocked": bool(decided and decided.get("pre_positioning_blocked")),
            "proactive_outreach_queued": bool(decided and decided.get("proactive_outreach_queued"))}
    def process_meter_commissioning(self, data: dict): pass
    def process_ramco_collection(self, data: dict): pass
    def update_hts_batch(self, data: dict): pass
    def update_wolseley_stock(self, data: dict): pass

    def generate_weekly_report(self, week_of: str | None) -> dict:
        exceptions = self._snapshot.get("exceptions", [])
        return {
            "week_of": week_of or date.today().isoformat(),
            "executive_summary": self._gen_executive_kpis(),
            "exception_count": len(exceptions),
            "pos_raised": len(self._snapshot.get("purchase_orders", [])),
            "response_plans_activated": len([e for e in exceptions if e.get("plan_activated")]),
            "generated_at": datetime.now(timezone.utc).isoformat()}


synthetic_state = SyntheticState()
