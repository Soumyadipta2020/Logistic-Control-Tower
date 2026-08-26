"""
State-engine update cadence — how often each parameter family is allowed to move.

The engine used to redraw *everything* on one 60-second heartbeat. That has two
problems, and they pull in opposite directions:

  1. It is not realistic. A telematics ping, a WMS throughput rollup, a 3PL scan
     event and a supplier OTIF scorecard do not arrive at the same rate in any
     real network. Redrawing a supplier's 12-week OTIF every minute makes the
     number look like noise; redrawing a van's GPS position every 15 minutes
     makes the map look frozen.

  2. It erases the user. If a dispatcher resolves a van-stock alert and the very
     next heartbeat re-randomises that van inside its scenario band, the action
     they just took leaves no trace. The impact of a decision has to survive long
     enough to be seen.

So each family declares its own interval, taken from the cadence its real source
system actually publishes at, plus a HOLD: a window after a user (or ATLAS) acts
on a specific entity during which the random redraw skips that entity. The action
sets the value; the simulation is not allowed to argue with it until the hold
expires. A family may declare `hold_minutes=0` where freezing the entity would
misrepresent it rather than explain it — see `route_progress`.

`seconds` is the *simulated* feed rate. Where a real feed is daily (supplier
scorecards, labour risk, MOT/compliance) the interval is compressed to the
longest value that still moves at least once inside a demo session — the ordering
between families, which is what makes the network feel real, is preserved.
"""
from __future__ import annotations

# The scheduler heartbeat. Every feed interval below is a multiple of this, so a
# feed fires on the first tick at or after its interval has elapsed.
TICK_INTERVAL_S = 30


def _feed(label, seconds, source, why, hold_minutes=15, real_world=None):
    return {
        "label": label,
        "seconds": seconds,
        "source": source,
        "why": why,
        # How long a user/ATLAS action on one entity in this family pins that
        # entity against random redraw, so the impact of the action is visible.
        "hold_minutes": hold_minutes,
        # What the real feed does, for the operator-facing readout.
        "real_world": real_world or why,
    }


FEEDS: dict[str, dict] = {
    # ── Fast: physical movement ──────────────────────────────────────────────
    "engineer_positions": _feed(
        "Engineer / van positions", 30, "Webfleet telematics",
        "Vehicle trackers ping every 30–60s while the ignition is on.",
        hold_minutes=0,
        real_world="30–60s ping"),
    # The one family with NO hold. Everywhere else, freezing the entity is what
    # makes an action legible; here it would be a lie. A round that has just been
    # re-sequenced is back in the same traffic thirty seconds later, and holding
    # its delay at the post-action figure tells a dispatcher the problem is
    # settled when the road says otherwise. So the round returns to live drift
    # immediately, and the evidence of what was done moves to where it belongs:
    # the audit trail (`resolution_log`), surfaced as the rounds-actioned-today
    # count on Transport Control.
    "route_progress": _feed(
        "Route progress & arrival risk", 120, "Salesforce FS + OSRM traffic",
        "ETAs are only worth recomputing when traffic or a stop status changes — "
        "a two-minute cycle tracks reality without flapping the arrival list.",
        hold_minutes=0,
        real_world="2–5 min ETA refresh"),

    # ── Medium: transactional events ─────────────────────────────────────────
    "carrier_tracking": _feed(
        "Third-party carrier tracking", 300, "Carrier EDI / API scan events",
        "Carriers publish milestone scans (collected, in transit, out for "
        "delivery) — typically one every 5–15 minutes on a live consignment.",
        hold_minutes=30,
        real_world="5–15 min scan events"),
    "warehouse_throughput": _feed(
        "Warehouse throughput", 300, "TVS SCS WMS",
        "Items-per-hour is a rolling rollup the WMS republishes every 5 minutes; "
        "faster than that is measuring the same pickers twice.",
        hold_minutes=30,
        real_world="5 min WMS rollup"),
    "van_stock": _feed(
        "Van stock levels", 900, "Salesforce FS van-stock scans",
        "Van stock only changes when an engineer consumes or receives a part, "
        "which in practice is a handful of scans per hour.",
        hold_minutes=60,
        real_world="on scan, ~15 min settle"),
    "locker_telemetry": _feed(
        "Locker fill & pre-8AM status", 900, "ByBox telemetry",
        "Locker doors and fill levels report on a quarter-hourly heartbeat; the "
        "pre-8AM result itself is settled once per day at the cut-off.",
        hold_minutes=90,
        real_world="15 min heartbeat"),

    # ── Slow: planning and analytics ─────────────────────────────────────────
    "kpis": _feed(
        "KPI families & rollups", 300, "Analytics warehouse",
        "Operational KPIs are 5-minute aggregates — recomputing per minute shows "
        "sampling noise, not performance.",
        hold_minutes=30,
        real_world="5 min aggregate"),
    "demand_signals": _feed(
        "Demand signals (weather · IoT)", 600, "Met Office + Hive",
        "Weather observations land hourly and Hive fault signals are batched — a "
        "10-minute cycle is already generous.",
        hold_minutes=30,
        real_world="hourly observations"),
    "inventory_planning": _feed(
        "Inventory cover & replenishment", 1800, "SAP net-change MRP",
        "Net-change MRP runs on a planning cycle, not continuously. Days-of-cover "
        "that jumps every minute cannot be planned against.",
        hold_minutes=120,
        real_world="net-change MRP cycle"),
    "sto_lifecycle": _feed(
        "Stock transfer lifecycle", 900, "SAP STO status",
        "Transfer orders step through pick → load → trunk → receipt on physical "
        "milestones, not on a clock.",
        hold_minutes=60,
        real_world="milestone driven"),
    "fleet_compliance": _feed(
        "Fleet compliance & telematics scores", 3600, "Webfleet + fleet system",
        "Walkarounds, MOT countdowns and driver-behaviour scores are daily "
        "records; hourly is already faster than the source.",
        hold_minutes=240,
        real_world="daily record"),
    "supplier_scorecards": _feed(
        "Supplier OTIF scorecards", 3600, "SAP Ariba",
        "OTIF is a weekly commercial measure. Moving it faster than hourly would "
        "make a contractual number look like a sensor reading.",
        hold_minutes=240,
        real_world="weekly scorecard"),
    "labour_risk": _feed(
        "Warehouse labour risk", 3600, "3PL workforce feed",
        "Absence, turnover and agency mix are daily HR figures.",
        hold_minutes=240,
        real_world="daily HR feed"),
}

# Families whose value the operator can change directly, and therefore where a
# hold is what makes their action legible. `route_progress` is deliberately not
# here: it is operator-actionable, but its impact is evidenced by the audit trail
# rather than by pinning the round — see the feed's own note above.
ACTIONABLE_FEEDS = (
    "van_stock", "locker_telemetry", "carrier_tracking",
    "warehouse_throughput", "inventory_planning",
)


def feed_seconds(name: str) -> int:
    return FEEDS.get(name, {}).get("seconds", TICK_INTERVAL_S)


def hold_seconds(name: str) -> int:
    return FEEDS.get(name, {}).get("hold_minutes", 15) * 60


def summary() -> list[dict]:
    """The cadence table, ordered fastest first — rendered verbatim by the UI so
    what an operator reads is literally what the engine runs."""
    return [
        {"feed": name, **cfg, "interval_label": _interval_label(cfg["seconds"])}
        for name, cfg in sorted(FEEDS.items(), key=lambda kv: kv[1]["seconds"])
    ]


def _interval_label(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    return f"{seconds // 3600}h"
