"""
Operational resolution engine — the four failure modes the control tower is
actually staffed to fix, and what an operator can DO about each one.

    1. Van stock alerts        an engineer's van is below minimum on a part
    2. Pre-8AM locker misses   the overnight wave did not land before first job
    3. Third-party carrier legs hub → locker / in-boot / job site, and their delays
    4. Arrival risk            an engineer will not reach one or more jobs in time

Each of those produces a typed alert row carrying its own OPTIONS: the concrete
courses of action a dispatcher has, each priced (cost, ETA, SLA impact,
confidence) against the live state rather than offered as generic advice. An
option is only offered when the state can actually support it — an inter-van
transfer needs a donor van within reach, a locker failover needs a healthy site
in the same round — and every option, when applied, mutates the snapshot the same
way the underlying real-world action would.

The option catalogues are grounded in how field-service and 3PL control towers
work in practice: parts moved between vans / from a forward stock location
before buying; jobs reallocated to whoever already carries the part; SLA
escalation at the midpoint of the window rather than at breach; backup-carrier
agreements and multi-modal switching for a late consignment; proactive customer
contact before the miss rather than after.

Nothing here imports the state module at import time — the mixin reads
everything it needs off `self._snapshot`, which keeps `state.py` free to import
this file.
"""
from __future__ import annotations

import logging
import math
import random
import uuid
from datetime import datetime, timezone, timedelta

# The action catalogue is leaf-level (it imports nothing from this package), so
# reading it here keeps `state.py` free to import this module.
from app.synthetic.actions import ACTION_BY_THRESHOLD
# One definition of "still to be driven to", shared with the optimiser. See
# routing.TERMINAL_STOP_STATUSES for why this is not `status != "completed"`.
from app.synthetic.routing import TERMINAL_STOP_STATUSES, drivable, is_drivable

_log = logging.getLogger("clt.resolutions")


# ═════════════════════════════════════════════════════════════════════════════
# Reference data
# ═════════════════════════════════════════════════════════════════════════════

# Third-party carriers used for the hub → forward-location leg. `two_man` is the
# bulky-goods crew (cylinders, heat pump outdoor units, full boiler swaps) that
# cannot go in a locker or an engineer's boot.
CARRIERS = [
    {"code": "BYB", "name": "ByBox Overnight", "services": ["pre_8am", "in_boot"], "otif_base": 96.5, "backup": "DPD"},
    {"code": "DPD", "name": "DPD Local", "services": ["pre_8am", "next_day", "same_day"], "otif_base": 95.0, "backup": "TUF"},
    {"code": "TUF", "name": "Tuffnells Bulky", "services": ["two_man", "next_day"], "otif_base": 88.5, "backup": "PLR"},
    {"code": "PLR", "name": "Palletline", "services": ["two_man"], "otif_base": 90.0, "backup": "TUF"},
    {"code": "CTY", "name": "CitySprint Same-Day", "services": ["same_day"], "otif_base": 93.0, "backup": "DPD"},
]
CARRIER_BY_CODE = {c["code"]: c for c in CARRIERS}

SERVICE_META = {
    "pre_8am":  {"label": "Pre-8AM locker", "cutoff": "18:00", "promise": "07:00", "cost_base": 9.5},
    "in_boot":  {"label": "In-boot overnight", "cutoff": "17:30", "promise": "06:30", "cost_base": 12.0},
    "same_day": {"label": "Same-day dedicated", "cutoff": "—", "promise": "+4h", "cost_base": 78.0},
    "next_day": {"label": "Next-day standard", "cutoff": "16:00", "promise": "12:00", "cost_base": 7.0},
    "two_man":  {"label": "Two-man bulky", "cutoff": "14:00", "promise": "booked slot", "cost_base": 165.0},
}

# Parts that cannot ride in a locker or a van boot — these force a two-man
# delivery to the job address on the day.
BULKY_PARTS = [
    ("SKU-HP-001", "Heat Pump Outdoor Unit 7kW", 78),
    ("SKU-HP-002", "Pre-plumbed Cylinder 210L", 96),
    ("SKU-BLR-010", "Combi Boiler 30kW (full swap)", 38),
    ("SKU-EV-001", "EV Charger 7.4kW + Pedestal", 24),
]

# Van-stock SKUs that go through the locker / in-boot network.
FORWARD_PARTS = [
    ("SKU-BLR-001", "Diverter Valve - Vaillant ecoTEC"),
    ("SKU-BLR-002", "Heat Exchanger - Navien NCB-E"),
    ("SKU-BLR-004", "PCB Control Board"),
    ("SKU-BLR-005", "Pressure Relief Valve"),
    ("SKU-BLR-007", "Igniter Assembly"),
    ("SKU-SM-001", "Smart Meter SMETS2 Single Phase"),
]

MOVEMENT_STATUS_FLOW = ["booked", "collected", "in_transit", "out_for_delivery", "delivered"]

# Why a pre-8AM wave misses. Each reason unlocks a different option set — a
# comms loss is recoverable with a master-key override, a missed cut-off is not.
LOCKER_MISS_REASONS = {
    "carrier_missed_cutoff": {
        "label": "Carrier missed the 18:00 cut-off",
        "detail": "The consignment was not collected from the hub in time to make the overnight wave.",
        "recoverable_same_day": True},
    "comms_loss": {
        "label": "Locker telemetry offline",
        "detail": "Stock may be physically present but delivery cannot be confirmed — engineers will not risk the trip.",
        "recoverable_same_day": True},
    "over_capacity": {
        "label": "No free slots at the site",
        "detail": "Uncollected stock is holding the doors — the wave had nowhere to land.",
        "recoverable_same_day": True},
    "wave_not_loaded": {
        "label": "Wave not loaded at hub",
        "detail": "The pick was short at the hub, so the consignment never left.",
        "recoverable_same_day": False},
}

# Why an engineer is going to be late.
ETA_CAUSES = {
    "traffic": "Congestion and incidents on the remaining legs",
    "job_overrun": "The current job is running long",
    "parts_collection": "An unplanned parts-collection stop was inserted",
    "late_start": "Late start — van stock or walkaround held the round up",
    "vehicle_defect": "Vehicle fault reported mid-round",
}


# ═════════════════════════════════════════════════════════════════════════════
# Small helpers (kept local so this module never imports state.py)
# ═════════════════════════════════════════════════════════════════════════════

def _rnd(lo: float, hi: float, dp: int = 1) -> float:
    return round(random.uniform(lo, hi), dp)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def miles_between(lat1, lon1, lat2, lon2) -> float:
    """Great-circle miles, then a 1.35 road factor — the same crude road model
    the route generator uses, so distances agree across the two modules."""
    if None in (lat1, lon1, lat2, lon2):
        return 999.0
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * r * math.asin(math.sqrt(a)) * 1.35, 1)


def drive_mins(miles: float, avg_mph: float = 28.0) -> int:
    return max(3, int(miles / avg_mph * 60))


def _parse_hhmm(value: str | None) -> tuple[int, int] | None:
    if not value or ":" not in str(value):
        return None
    try:
        h, m = str(value).split(":")[:2]
        return int(h), int(m)
    except ValueError:
        return None


def add_mins(hhmm: str | None, minutes: int) -> str | None:
    """Shift an "HH:MM" clock time, clamped to the working day."""
    parsed = _parse_hhmm(hhmm)
    if parsed is None:
        return hhmm
    total = parsed[0] * 60 + parsed[1] + minutes
    total = max(0, min(23 * 60 + 59, total))
    return f"{total // 60:02d}:{total % 60:02d}"


def mins_between(a: str | None, b: str | None) -> int:
    """b − a in minutes; 0 if either is unparseable."""
    pa, pb = _parse_hhmm(a), _parse_hhmm(b)
    if pa is None or pb is None:
        return 0
    return (pb[0] * 60 + pb[1]) - (pa[0] * 60 + pa[1])


def _opt(action, label, blurb, *, available=True, unavailable_reason=None,
         eta_mins=None, cost_gbp=0.0, sla_impact="", confidence=80,
         recommended=False, autonomy="human", threshold_key=None,
         detail="", consequence="", **extra) -> dict:
    """One course of action, priced against live state."""
    return {
        "action": action, "label": label, "blurb": blurb, "detail": detail,
        "available": available, "unavailable_reason": unavailable_reason,
        "eta_mins": eta_mins, "cost_gbp": round(cost_gbp, 2), "sla_impact": sla_impact,
        "confidence": confidence, "recommended": recommended,
        "autonomy": autonomy, "threshold_key": threshold_key,
        "consequence": consequence, **extra,
    }


def _rank(options: list[dict]) -> list[dict]:
    """Available first, then recommended, then by SLA protection and cost."""
    return sorted(options, key=lambda o: (
        not o["available"], not o["recommended"], o.get("eta_mins") or 999, o["cost_gbp"]))


def preferred_option(options: list[dict]) -> dict | None:
    """The action the engine itself recommends for this alert.

    Options arrive pre-ranked (available → recommended → biggest time recovery →
    cheapest), so the first available row carrying `recommended` IS the
    recommendation. Where nothing is flagged — a state the catalogue has no
    strong view on — the top-ranked available option stands in, and callers can
    tell the difference from the `recommended` flag on the option itself so the
    reasoning trace never overstates its own conviction.
    """
    available = [o for o in options if o.get("available")]
    if not available:
        return None
    return next((o for o in available if o.get("recommended")), available[0])


# ═════════════════════════════════════════════════════════════════════════════
# The mixin
# ═════════════════════════════════════════════════════════════════════════════

class ResolutionMixin:
    """Mixed into SyntheticState. Every method reads and writes `self._snapshot`."""

    # ── shared plumbing ──────────────────────────────────────────────────────

    def _state(self) -> dict:
        """Every public entry point below goes through here.

        The snapshot is built lazily, and these accessors are reachable before
        anything else has touched it (a router hit on a cold worker, a test
        client that never ran the lifespan). Reading `_snapshot` directly in that
        window returns an empty dict and the endpoint reports a perfectly healthy
        network with nothing in it — the most dangerous possible failure mode for
        an alert queue.
        """
        return self.get_snapshot()

    def _res_log(self, kind: str, subject: str, action: str, by: str, summary: str,
                 *, threshold_key: str | None = None, **extra) -> dict:
        """Append to the resolution audit trail every module reads back.

        Two things are stamped here that the caller does not have to restate.

        WHERE the action lives — module, tab, section — is read off the action
        catalogue via its threshold key rather than written out again, so the
        audit trail, the per-section "actioned today" counters and the Governance
        tab cannot drift apart about which section owns an action.

        HOW it was taken — `source` — is what stops the unified audit trail
        double-counting. A resolution reached through the ATLAS approvals queue is
        already logged by the agent engine; one taken straight off a module screen
        is not logged anywhere else. `apply_resolution` is the single entry point
        the queue uses, and it is what sets the flag.
        """
        s = self._snapshot
        cfg = ACTION_BY_THRESHOLD.get(threshold_key or "") or {}
        entry = {
            "log_id": f"RES-{uuid.uuid4().hex[:8].upper()}",
            "kind": kind, "subject": subject, "action": action,
            "by": by, "summary": summary, "at": _iso(_now()),
            "threshold_key": threshold_key, "action_key": cfg.get("key"),
            "action_label": cfg.get("label"),
            "module": cfg.get("module"), "module_label": cfg.get("module_label"),
            "tab": cfg.get("tab"), "section": cfg.get("section"),
            "autonomy": cfg.get("autonomy"),
            "source": "agent_queue" if getattr(self, "_resolution_via_queue", False) else "module",
            **extra}
        log = s.setdefault("resolution_log", [])
        log.insert(0, entry)
        del log[200:]
        return entry

    def _post_outbound(self, system: str, endpoint: str, payload: dict,
                       *, status_code: int = 202, response: dict | None = None) -> dict:
        """Record an outbound call to a downstream system.

        Nothing leaves this process — the demo has no downstream to call — so the
        record is explicitly flagged `simulated`. What it does carry is the exact
        endpoint, payload and acknowledgement the real integration would produce,
        so the contract is reviewable and the Integration Log shows the operator
        that the action left the tower rather than only changing a number here.
        """
        s = self._snapshot
        ref = f"REQ-{uuid.uuid4().hex[:10].upper()}"
        entry = {
            "log_id": ref, "at": _iso(_now()), "direction": "outbound",
            "system": system, "endpoint": endpoint, "request": payload,
            "status_code": status_code,
            "response": response or {"accepted": True, "reference": ref,
                                     "queued_at": _iso(_now())},
            "simulated": True}
        log = s.setdefault("integration_log", [])
        log.insert(0, entry)
        del log[100:]
        return entry

    def _engineer(self, code: str) -> dict | None:
        return next((e for e in self._snapshot.get("engineer_locations", [])
                     if e.get("engineer_code") == code), None)

    def _van_for(self, code: str) -> dict | None:
        return next((v for v in self._snapshot.get("fleet_vehicles", [])
                     if v.get("engineer_code") == code), None)

    def _hubs(self) -> list[dict]:
        return self._snapshot.get("warehouse_status", [])

    def _nearest_hub(self, lat, lon) -> dict | None:
        hubs = [h for h in self._hubs() if h.get("latitude") is not None]
        if not hubs:
            return None
        return min(hubs, key=lambda h: miles_between(lat, lon, h["latitude"], h["longitude"]))

    def _nearest_locker(self, lat, lon, *, healthy_only=True, exclude=()) -> dict | None:
        pool = [
            l for l in self._snapshot.get("locker_status", [])
            if l.get("bybox_site_code") not in exclude
            and (not healthy_only or l.get("status") == "healthy")]
        if not pool:
            return None
        return min(pool, key=lambda l: miles_between(lat, lon, l.get("latitude"), l.get("longitude")))

    # ═════════════════════════════════════════════════════════════════════════
    # THE RECOMMENDATION SURFACE
    # ═════════════════════════════════════════════════════════════════════════

    def recommended_resolutions(self, *, limit_per_kind: int = 12,
                                kinds: tuple = ("van", "locker", "carrier", "eta")) -> list[dict]:
        """For every open alert, the one action the option engine recommends.

        This is the single source of truth for *what should be done here*. The
        operator's card reads it, ATLAS's autonomous pass reads it, and the
        approval queue reads it — so all three always name the same fix.

        It deliberately answers only that question. *Who may press it* is a
        separate one, answered downstream by the action catalogue's autonomy
        class: `auto` self-executes inside its guardrails, anything else is
        escalated for a human. Keeping the two apart is what lets the same
        recommendation be auto-executed on a routine alert and require approval
        on a severe one, without the recommendation itself changing.
        """
        out: list[dict] = []

        if "van" in kinds:
            for a in [x for x in self._state().get("van_stock_alerts", [])
                      if x.get("status") == "open"][:limit_per_kind]:
                opt = preferred_option(self.van_alert_options(a))
                if not opt:
                    continue
                skus = ", ".join(i["sku_code"] for i in a["shortfall"][:2])
                out.append(self._recommendation(
                    kind="van", subject=a["engineer_code"], agent="visibility", alert=a, option=opt,
                    subject_label=f"{a['engineer_name']} · {a.get('registration') or a['engineer_code']}",
                    severity=a["severity"],
                    title=f"{opt['label']} — {a['engineer_name']}",
                    detail=(f"Van is {a['shortfall_units']} unit(s) short on {skus} with "
                            f"{a['jobs_at_risk']} stop(s) left today. {opt['blurb']}."),
                    module_hint="Live Visibility Hub · Van Alerts"))

        if "locker" in kinds:
            for m in [x for x in self._state().get("locker_misses", [])
                      if x.get("status") == "open"][:limit_per_kind]:
                opt = preferred_option(self.locker_miss_options(m))
                if not opt:
                    continue
                out.append(self._recommendation(
                    kind="locker", subject=m["site_code"], agent="visibility", alert=m, option=opt,
                    subject_label=f"{m['site_code']} · {m.get('region')}",
                    severity=m["severity"],
                    title=f"{opt['label']} — {m['site_code']}",
                    detail=(f"{m['reason_label']}. {m['engineers_affected']} engineer(s) and "
                            f"{m['jobs_at_risk']} job(s) depend on this site before "
                            f"{m['first_job_at']}. {opt['blurb']}."),
                    module_hint="Live Visibility Hub · Lockers"))

        if "carrier" in kinds:
            late = [m for m in self._state().get("carrier_movements", [])
                    if (m.get("delay_mins") or 0) > 0 and m.get("status") != "delivered"
                    and not m.get("resolution")]
            for mv in sorted(late, key=lambda m: -(m["delay_mins"]))[:limit_per_kind]:
                opt = preferred_option(self.carrier_options(mv))
                if not opt:
                    continue
                delay = mv["delay_mins"]
                out.append(self._recommendation(
                    kind="carrier", subject=mv["movement_ref"], agent="transport", alert=mv, option=opt,
                    subject_label=f"{mv['movement_ref']} · {mv['carrier']}",
                    severity="critical" if delay >= 240 else "high" if delay >= 90 else "medium",
                    title=f"{opt['label']} — {mv['movement_ref']}",
                    detail=(f"{mv['carrier']} {mv['service_label'].lower()} leg into {mv['dest_name']} is "
                            f"{delay} min late"
                            + (" and cannot be split or substituted." if mv["is_bulky"] else ".")
                            + f" {opt['blurb']}."),
                    module_hint="Transport Control · Carriers"))

        if "eta" in kinds:
            for r in [x for x in self._state().get("route_eta_risk", [])
                      if x.get("status") == "open"][:limit_per_kind]:
                opt = preferred_option(self.eta_risk_options(r))
                if not opt:
                    continue
                out.append(self._recommendation(
                    kind="eta", subject=r["engineer_code"], agent="transport", alert=r, option=opt,
                    subject_label=f"{r['engineer_name']} · {r.get('registration') or r['engineer_code']}",
                    severity=r["severity"],
                    title=f"{opt['label']} — {r['engineer_name']}",
                    detail=(f"Running {r['delay_mins']} min behind ({r['cause_label'].lower()}). "
                            f"{r['jobs_at_risk']} appointment(s) project past their window, worst by "
                            f"{r['worst_breach_mins']} min. {opt['blurb']}."),
                    module_hint="Transport Control · Routes"))

        # Worst first, so a capped consumer takes the ones that matter.
        out.sort(key=lambda r: ({"critical": 0, "high": 1, "medium": 2}.get(r["severity"], 3),
                                -r["confidence"]))
        return out

    @staticmethod
    def _recommendation(*, kind, subject, agent, alert, option, subject_label,
                        severity, title, detail, module_hint) -> dict:
        return {
            "kind": kind, "subject": subject, "subject_label": subject_label,
            "agent": agent, "alert": alert, "option": option,
            "action": option["action"], "threshold_key": option["threshold_key"],
            "label": option["label"], "severity": severity,
            "confidence": option["confidence"], "cost_gbp": round(option["cost_gbp"]),
            "eta_mins": option.get("eta_mins"), "sla_impact": option.get("sla_impact"),
            # False means nothing in the catalogue was flagged for this state and
            # the top-ranked available option stood in — worth saying out loud
            # rather than presenting a fallback as a considered recommendation.
            "recommended": bool(option.get("recommended")),
            "title": title, "detail": detail, "module_hint": module_hint,
            "consequence": option.get("consequence"),
        }

    def apply_resolution(self, kind: str, subject: str, action: str, by: str,
                         params: dict | None = None) -> dict:
        """One entry point for applying any resolution, whoever decided it.

        A human clicking the option, ATLAS executing it autonomously and an
        operator approving it from the queue all land here, so the state change,
        the audit trail and the outbound posts are identical in all three cases —
        the only thing that differs is the name on the decision.
        """
        handler = {
            "van": self.resolve_van_alert,
            "locker": self.resolve_locker_miss,
            "carrier": self.resolve_carrier_movement,
            "eta": self.resolve_eta_risk,
        }.get(kind)
        if handler is None:
            return {"error": f"Unknown resolution kind '{kind}'"}
        # Mark the audit entry the handler is about to write as having come
        # through the queue, so the unified trail does not show it twice — the
        # agent engine logs this same action itself. See `_res_log`.
        self._resolution_via_queue = True
        try:
            return handler(subject, action, by, params)
        finally:
            self._resolution_via_queue = False

    # ═════════════════════════════════════════════════════════════════════════
    # 1 · VAN STOCK ALERTS
    # ═════════════════════════════════════════════════════════════════════════

    def refresh_van_stock_alerts(self) -> list[dict]:
        """Rebuild the van-stock alert list from engineer van stock.

        Alerts already carrying a resolution are preserved — an operator's action
        must not be erased by the next rebuild.
        """
        s = self._snapshot
        existing = {a["engineer_code"]: a for a in s.get("van_stock_alerts", [])}
        routes = s.get("engineer_routes", {})
        alerts: list[dict] = []
        now = _now()

        for eng in s.get("engineer_locations", []):
            items = eng.get("van_stock_items", []) or []
            shortfall = [
                {**it, "shortfall": max(0, (it.get("min_quantity") or 0) - (it.get("quantity") or 0))}
                for it in items
                if (it.get("quantity") or 0) < (it.get("min_quantity") or 0)]
            eng["van_stock_low"] = bool(shortfall)
            if not shortfall:
                continue

            code = eng["engineer_code"]
            prev = existing.get(code)
            route = routes.get(code) or {}
            stops = route.get("stops", []) or []
            remaining = drivable(stops)
            next_stop = next((st for st in stops if st.get("status") == "next"), None) \
                or (remaining[0] if remaining else None)

            # Severity is about consequence, not about the number. A line at zero
            # only becomes critical when the very next appointment is one that
            # carries a contractual window — the same shortage in front of a
            # routine service can be worked at the next collection point.
            at_zero = any((it.get("quantity") or 0) == 0 for it in shortfall)
            next_priority = (next_stop or {}).get("priority", "standard")
            severity = ("critical" if at_zero and next_priority in ("P1", "P2")
                        else "high" if at_zero or len(remaining) >= 4
                        else "medium")
            van = self._van_for(code)

            alert = {
                "alert_id": prev.get("alert_id") if prev else f"VSA-{uuid.uuid4().hex[:8].upper()}",
                "engineer_code": code,
                "engineer_name": eng.get("name"),
                "business_unit": eng.get("business_unit"),
                "region": eng.get("region"),
                "home_postcode": eng.get("home_postcode"),
                "latitude": eng.get("latitude"), "longitude": eng.get("longitude"),
                "job_status": eng.get("job_status"),
                "registration": van.get("registration") if van else None,
                "shortfall": shortfall,
                "shortfall_units": sum(i["shortfall"] for i in shortfall),
                "severity": severity,
                "jobs_at_risk": len(remaining),
                "next_job": ({
                    "job_code": next_stop.get("job_code"),
                    "job_type": next_stop.get("job_type"),
                    "postcode": next_stop.get("postcode"),
                    "planned_arrival": next_stop.get("planned_arrival"),
                    "seq": next_stop.get("seq"),
                    "latitude": next_stop.get("latitude"),
                    "longitude": next_stop.get("longitude")} if next_stop else None),
                "first_time_fix_at_risk": at_zero and bool(next_stop),
                "raised_at": prev.get("raised_at") if prev else _iso(now - timedelta(minutes=random.randint(5, 180))),
                "status": prev.get("status", "open") if prev else "open",
                "resolution": prev.get("resolution") if prev else None,
            }
            alerts.append(alert)

        alerts.sort(key=lambda a: ({"critical": 0, "high": 1, "medium": 2}.get(a["severity"], 3),
                                   -a["jobs_at_risk"]))
        s["van_stock_alerts"] = alerts
        return alerts

    def van_alert(self, engineer_code: str) -> dict | None:
        alert = next((a for a in self._state().get("van_stock_alerts", [])
                      if a["engineer_code"] == engineer_code), None)
        if alert is None:
            return None
        return {**alert, "options": self.van_alert_options(alert)}

    def van_alerts(self, *, region: str | None = None, severity: str | None = None,
                   include_options: bool = False) -> list[dict]:
        rows = self._state().get("van_stock_alerts", [])
        if region:
            rows = [a for a in rows if a.get("region") == region]
        if severity and severity != "all":
            rows = [a for a in rows if a.get("severity") == severity]
        if include_options:
            return [{**a, "options": self.van_alert_options(a)} for a in rows]
        return rows

    # ── option builder ───────────────────────────────────────────────────────

    def _find_donor_van(self, alert: dict) -> tuple[dict | None, float]:
        """Nearest engineer holding surplus of any short SKU — surplus meaning
        above their own minimum, so covering one van never strands another."""
        wanted = {i["sku_code"] for i in alert["shortfall"]}
        best, best_miles = None, 999.0
        for eng in self._snapshot.get("engineer_locations", []):
            if eng["engineer_code"] == alert["engineer_code"]:
                continue
            if eng.get("job_status") in ("off_duty",):
                continue
            surplus = [
                it for it in eng.get("van_stock_items", []) or []
                if it.get("sku_code") in wanted
                and (it.get("quantity") or 0) > (it.get("min_quantity") or 0)]
            if not surplus:
                continue
            m = miles_between(alert["latitude"], alert["longitude"],
                              eng.get("latitude"), eng.get("longitude"))
            if m < best_miles:
                best, best_miles = eng, m
        return best, best_miles

    def _find_cover_engineer(self, alert: dict) -> tuple[dict | None, float]:
        """Nearest engineer who both carries the part AND has room in the day —
        the one who can take the job over rather than just hand a part across."""
        routes = self._snapshot.get("engineer_routes", {})
        wanted = {i["sku_code"] for i in alert["shortfall"]}
        best, best_miles = None, 999.0
        for eng in self._snapshot.get("engineer_locations", []):
            code = eng["engineer_code"]
            if code == alert["engineer_code"] or eng.get("job_status") == "off_duty":
                continue
            if eng.get("business_unit") != alert.get("business_unit"):
                continue        # skills/accreditation must match the job type
            if eng.get("van_stock_low"):
                continue
            holds = {it.get("sku_code") for it in eng.get("van_stock_items", []) or []
                     if (it.get("quantity") or 0) > (it.get("min_quantity") or 0)}
            if not (wanted & holds):
                continue
            r = routes.get(code) or {}
            if (r.get("stops_total") or 0) - (r.get("stops_completed") or 0) >= 5:
                continue        # no capacity left in their day
            m = miles_between(alert["latitude"], alert["longitude"],
                              eng.get("latitude"), eng.get("longitude"))
            if m < best_miles:
                best, best_miles = eng, m
        return best, best_miles

    def _collection_point(self, alert: dict) -> tuple[dict | None, float, str]:
        """Nearest place the parts can actually be picked up: a healthy locker
        holding stock, else the nearest hub trade counter."""
        lat, lon = alert["latitude"], alert["longitude"]
        locker = self._nearest_locker(lat, lon)
        hub = self._nearest_hub(lat, lon)
        lm = miles_between(lat, lon, locker.get("latitude"), locker.get("longitude")) if locker else 999.0
        hm = miles_between(lat, lon, hub.get("latitude"), hub.get("longitude")) if hub else 999.0
        if locker and lm <= hm:
            return locker, lm, "locker"
        if hub:
            return hub, hm, "hub"
        return None, 999.0, "none"

    def van_alert_options(self, alert: dict) -> list[dict]:
        if alert.get("status") == "resolved":
            return []
        skus = ", ".join(i["sku_code"] for i in alert["shortfall"][:3])
        units = alert["shortfall_units"]
        options: list[dict] = []

        # 1 · Inter-van transfer — no new stock, no spend, fastest when a donor
        #     is genuinely close. Loses time from BOTH engineers' days, so it is
        #     only the right answer inside a short radius.
        donor, donor_miles = self._find_donor_van(alert)
        if donor:
            leg = drive_mins(donor_miles / 2) + 10          # meet in the middle + handover
            options.append(_opt(
                "inter_van_transfer", "Inter-van transfer",
                f"Take {units} unit(s) from {donor['name']} — {donor_miles} mi away",
                detail=(f"{donor['name']} ({donor['engineer_code']}) holds surplus above their own "
                        f"minimum. Meet at the midpoint, hand over {skus}, both rounds continue."),
                eta_mins=leg, cost_gbp=donor_miles * 0.18 + 6.0,
                sla_impact=f"+{leg} min to both rounds", confidence=88,
                recommended=donor_miles <= 12,
                autonomy="auto", threshold_key="van_inter_transfer",
                consequence="Donor van drops to its minimum on this line and is queued for tonight's wave.",
                donor_engineer_code=donor["engineer_code"], donor_engineer_name=donor["name"],
                distance_miles=donor_miles))
        else:
            options.append(_opt(
                "inter_van_transfer", "Inter-van transfer",
                "No van within reach holds surplus on these lines",
                available=False,
                unavailable_reason="Every nearby van is at or below its own minimum on these SKUs.",
                autonomy="auto", threshold_key="van_inter_transfer"))

        # 2 · Job reallocation — protects the customer appointment rather than
        #     the engineer's round. The right answer when the part cannot get to
        #     this van before the slot.
        cover, cover_miles = self._find_cover_engineer(alert)
        if cover and alert.get("next_job"):
            options.append(_opt(
                "job_reallocation", "Reallocate the job",
                f"Move {alert['next_job']['job_code']} to {cover['name']} — {cover_miles} mi away",
                detail=(f"{cover['name']} already carries the part, matches the {alert.get('business_unit')} "
                        f"accreditation and has capacity left today. The appointment holds; this van "
                        f"keeps the rest of its round."),
                eta_mins=drive_mins(cover_miles),
                cost_gbp=cover_miles * 0.18,
                sla_impact="Appointment protected", confidence=84,
                recommended=alert["severity"] == "critical" and cover_miles <= 20,
                autonomy="human", threshold_key="van_job_reallocation",
                consequence="Changes two engineers' working day — dispatcher approval required.",
                cover_engineer_code=cover["engineer_code"], cover_engineer_name=cover["name"],
                job_code=alert["next_job"]["job_code"], distance_miles=cover_miles))
        else:
            options.append(_opt(
                "job_reallocation", "Reallocate the job",
                "No accredited engineer nearby has both the part and capacity",
                available=False,
                unavailable_reason=("No remaining job to move." if not alert.get("next_job")
                                    else "No accredited engineer within reach holds the part with capacity left."),
                autonomy="human", threshold_key="van_job_reallocation"))

        # 3 · Collect en route — inserts a real stop into the van's route in
        #     Transport Control ahead of the job that needs the part.
        point, point_miles, kind = self._collection_point(alert)
        if point:
            detour = drive_mins(point_miles) + 10
            name = point.get("bybox_site_code") if kind == "locker" else point.get("name")
            options.append(_opt(
                "collect_en_route", f"Collect at {'locker' if kind == 'locker' else 'hub counter'}",
                f"Add a collection stop at {name} — {point_miles} mi",
                detail=(f"Inserts a parts-collection stop into this van's route in Transport Control, "
                        f"ahead of the job that needs {skus}. Remaining arrival times shift by the "
                        f"detour and the route is re-published to the engineer's device."),
                eta_mins=detour, cost_gbp=point_miles * 0.18,
                sla_impact=f"+{detour} min to the rest of the round", confidence=90,
                recommended=not donor or donor_miles > 12,
                autonomy="auto", threshold_key="van_collect_en_route",
                consequence="Every later stop on this round moves back by the detour.",
                point_kind=kind,
                point_code=point.get("bybox_site_code") or point.get("code"),
                point_name=name, distance_miles=point_miles))
        else:
            options.append(_opt(
                "collect_en_route", "Collect at locker or hub",
                "No collection point reachable", available=False,
                unavailable_reason="No healthy locker or hub within range of this van.",
                autonomy="auto", threshold_key="van_collect_en_route"))

        # 4 · Replenishment order — the structural fix. Posts the order to the
        #     van-replenishment system for tonight's wave; does nothing for a job
        #     happening this morning, which is why it is never the sole answer.
        cost = round(sum(max(1, i["shortfall"]) * 26.5 for i in alert["shortfall"]), 2)
        options.append(_opt(
            "van_replenishment_order", "Raise van replenishment order",
            f"Order {units} unit(s) into tonight's wave",
            detail=("Posts a van-replenishment order to the fulfilment system for the engineer's "
                    "home locker. Restores the van to standard quantities by 07:00 tomorrow — it "
                    "fixes the van, not today's job."),
            eta_mins=None, cost_gbp=cost,
            sla_impact="Lands 07:00 tomorrow", confidence=95,
            recommended=alert["severity"] != "critical",
            autonomy="auto", threshold_key="van_replenishment_order",
            consequence="Commits stock and a delivery slot; jobs before 07:00 tomorrow are unaffected.",
            units=units))

        return _rank(options)

    # ── apply ────────────────────────────────────────────────────────────────

    def resolve_van_alert(self, engineer_code: str, action: str, by: str,
                          params: dict | None = None) -> dict:
        params = params or {}
        s = self._state()
        alert = next((a for a in s.get("van_stock_alerts", [])
                      if a["engineer_code"] == engineer_code), None)
        if not alert:
            return {"error": "No open van stock alert for this engineer"}
        eng = self._engineer(engineer_code)
        if not eng:
            return {"error": "Engineer not found"}

        option = next((o for o in self.van_alert_options(alert) if o["action"] == action), None)
        if not option:
            return {"error": f"Unknown action '{action}'"}
        if not option["available"]:
            return {"error": option["unavailable_reason"] or "Action not available in the current state"}

        outcome: dict = {"action": action, "engineer_code": engineer_code}
        handler = getattr(self, f"_apply_van_{action}", None)
        if handler is None:
            return {"error": f"Action '{action}' has no handler"}
        outcome.update(handler(alert, eng, option, by, params) or {})

        alert["status"] = "resolved"
        alert["resolution"] = {
            "action": action, "label": option["label"], "by": by,
            "at": _iso(_now()), "summary": outcome.get("summary", option["label"]),
            "eta_mins": option.get("eta_mins"), "cost_gbp": option["cost_gbp"],
            **{k: v for k, v in outcome.items() if k not in ("summary",)}}

        # Pin this van against the next van-stock redraw so the operator can see
        # what their action did before the simulation moves it again.
        self.hold_entity("van_stock", f"engineer:{engineer_code}")
        self._res_log("van_stock_alert", engineer_code, action, by,
                      outcome.get("summary", option["label"]),
                      threshold_key=option["threshold_key"],
                      severity=alert["severity"], cost_gbp=option["cost_gbp"])
        self.refresh_van_stock_alerts()
        self._sync_derived_state()
        return {"resolved": True, **alert["resolution"]}

    def _restock_van(self, eng: dict, *, to_standard: bool = False) -> int:
        """Bring the short lines back up. Returns units moved."""
        moved = 0
        for it in eng.get("van_stock_items", []) or []:
            floor = (it.get("standard_quantity") if to_standard else it.get("min_quantity")) or 0
            if (it.get("quantity") or 0) < floor:
                moved += floor - (it.get("quantity") or 0)
                it["quantity"] = floor
            it["is_below_min"] = (it.get("quantity") or 0) < (it.get("min_quantity") or 0)
        eng["van_stock_low"] = any(i.get("is_below_min") for i in eng.get("van_stock_items", []) or [])
        return moved

    def _apply_van_inter_van_transfer(self, alert, eng, option, by, params) -> dict:
        donor = self._engineer(option["donor_engineer_code"])
        wanted = {i["sku_code"] for i in alert["shortfall"]}
        moved = 0
        if donor:
            for it in donor.get("van_stock_items", []) or []:
                if it.get("sku_code") in wanted and (it.get("quantity") or 0) > (it.get("min_quantity") or 0):
                    give = (it["quantity"] or 0) - (it.get("min_quantity") or 0)
                    it["quantity"] -= give
                    it["is_below_min"] = (it["quantity"] or 0) < (it.get("min_quantity") or 0)
                    moved += give
            donor["van_stock_low"] = any(i.get("is_below_min") for i in donor.get("van_stock_items", []) or [])
            self.hold_entity("van_stock", f"engineer:{donor['engineer_code']}")
        self._restock_van(eng)

        self._transfer_counter += 1
        transfer = {
            "transfer_id": f"TRF-{2026000 + self._transfer_counter}",
            "kind": "inter_van",
            "requesting_engineer": alert["engineer_code"],
            "requesting_engineer_name": alert["engineer_name"],
            "donor_engineer": option["donor_engineer_code"],
            "donor_engineer_name": option["donor_engineer_name"],
            "sku_codes": sorted(wanted), "quantity": moved or alert["shortfall_units"],
            "meeting_point": params.get("meeting_point") or self._midpoint_postcode(alert, donor),
            "distance_miles": option["distance_miles"],
            "eta_mins": option["eta_mins"],
            "status": "approved", "approved_by": by, "at": _iso(_now())}
        s = self._snapshot
        s.setdefault("van_transfers", []).insert(0, transfer)
        del s["van_transfers"][60:]
        return {
            "summary": (f"{moved or alert['shortfall_units']} unit(s) moving from "
                        f"{option['donor_engineer_name']} at {transfer['meeting_point']} "
                        f"(~{option['eta_mins']} min)"),
            "transfer_id": transfer["transfer_id"],
            "meeting_point": transfer["meeting_point"]}

    def _midpoint_postcode(self, alert, donor) -> str:
        from app.synthetic.state import rand_postcode        # deferred: avoids a cycle
        return rand_postcode(alert.get("region"))

    def _apply_van_job_reallocation(self, alert, eng, option, by, params) -> dict:
        """Move the at-risk stop off this route and onto the covering engineer's."""
        s = self._snapshot
        routes = s.get("engineer_routes", {})
        src = routes.get(alert["engineer_code"])
        dst = routes.get(option["cover_engineer_code"])
        job_code = params.get("job_code") or option["job_code"]
        moved_stop = None
        if src:
            for i, st in enumerate(src.get("stops", [])):
                if st.get("job_code") == job_code and st.get("status") != "completed":
                    moved_stop = src["stops"].pop(i)
                    break
            self._resequence(src)
        if moved_stop is not None and dst is not None:
            moved_stop = {**moved_stop,
                          "status": "pending",
                          "reallocated_from": alert["engineer_code"],
                          "reallocated_from_name": alert["engineer_name"],
                          "reallocated_at": _iso(_now()),
                          "planned_arrival": add_mins(
                              (dst.get("stops") or [{}])[-1].get("planned_arrival", "16:00"), 45)}
            dst.setdefault("stops", []).append(moved_stop)
            self._resequence(dst)
        return {
            "summary": (f"{job_code} reallocated to {option['cover_engineer_name']} "
                        f"({option['distance_miles']} mi) — appointment held"),
            "job_code": job_code,
            "cover_engineer_code": option["cover_engineer_code"],
            "cover_engineer_name": option["cover_engineer_name"]}

    def _apply_van_collect_en_route(self, alert, eng, option, by, params) -> dict:
        """Insert a parts-collection stop into the van's route in Transport
        Control, ahead of the job that needs the part."""
        stop = self.insert_collection_stop(
            alert["engineer_code"],
            point_kind=option["point_kind"], point_code=option["point_code"],
            point_name=option["point_name"], detour_mins=option["eta_mins"],
            sku_codes=[i["sku_code"] for i in alert["shortfall"]],
            reason="Van stock below minimum", by=by)
        if "error" in stop:
            return {"summary": stop["error"]}
        # The parts are in the van once the stop is made; the alert clears now
        # and the collection stop is what makes it true on the ground.
        self._restock_van(eng)
        return {
            "summary": (f"Collection stop added at {option['point_name']} "
                        f"({option['distance_miles']} mi) before {stop['before_job_code'] or 'the next job'} — "
                        f"round shifts +{option['eta_mins']} min"),
            "stop": stop["stop"], "route_stops_total": stop["stops_total"],
            "point_name": option["point_name"], "point_kind": option["point_kind"]}

    def _apply_van_van_replenishment_order(self, alert, eng, option, by, params) -> dict:
        """Raise the replenishment order and post it to the fulfilment system."""
        s = self._snapshot
        lines = [{"sku_code": i["sku_code"], "description": i.get("description"),
                  "quantity": max(1, (i.get("standard_quantity") or i.get("min_quantity") or 1)
                                  - (i.get("quantity") or 0))}
                 for i in alert["shortfall"]]
        order_ref = f"VRO-{2026000 + len(s.get('van_replenishment_orders', [])) + 1}"
        home_locker = self._nearest_locker(alert["latitude"], alert["longitude"])
        promise = (_now() + timedelta(days=1)).replace(hour=7, minute=0, second=0, microsecond=0)

        payload = {
            "order_ref": order_ref,
            "engineer_code": alert["engineer_code"],
            "engineer_name": alert["engineer_name"],
            "vehicle_registration": alert.get("registration"),
            "delivery_mode": "pre_8am_locker",
            "delivery_point": home_locker.get("bybox_site_code") if home_locker else None,
            "required_by": _iso(promise),
            "priority": "urgent" if alert["severity"] == "critical" else "standard",
            "lines": lines,
            "raised_by": by}
        call = self._post_outbound(
            "Salesforce Field Service · Van Replenishment",
            "POST https://fs.centrica-svc.internal/api/v1/van-replenishment-orders",
            payload)

        order = {
            **payload,
            "status": "accepted",
            "external_reference": call["response"]["reference"],
            "posted_at": call["at"],
            "carrier": "ByBox Overnight",
            "promised_at": _iso(promise),
            "total_cost_gbp": option["cost_gbp"]}
        s.setdefault("van_replenishment_orders", []).insert(0, order)
        del s["van_replenishment_orders"][80:]

        # The order also books the physical leg, so it shows up in Transport
        # Control alongside every other third-party movement.
        if home_locker:
            self.book_carrier_movement(
                origin_code=(self._nearest_hub(alert["latitude"], alert["longitude"]) or {}).get("code"),
                dest_type="locker", dest_code=home_locker["bybox_site_code"],
                service="pre_8am", lines=lines,
                linked_engineer_code=alert["engineer_code"],
                reason=f"Van replenishment {order_ref}", by=by)

        # The van is restocked when the wave lands, not now — but the alert is
        # owned and no longer needs a decision.
        return {
            "summary": (f"{order_ref} posted to Field Service — {sum(l['quantity'] for l in lines)} unit(s) "
                        f"to {payload['delivery_point'] or 'home locker'} by 07:00"),
            "order_ref": order_ref, "external_reference": order["external_reference"],
            "endpoint": call["endpoint"], "status_code": call["status_code"],
            "promised_at": order["promised_at"]}

    # ═════════════════════════════════════════════════════════════════════════
    # 2 · PRE-8AM LOCKER MISSES
    # ═════════════════════════════════════════════════════════════════════════

    def refresh_locker_misses(self) -> list[dict]:
        """Attach a cause and an impact figure to every locker that missed the
        pre-8AM wave, so the miss is a workable incident rather than a red dot."""
        s = self._snapshot
        engineers = s.get("engineer_locations", [])
        by_region: dict[str, int] = {}
        for e in engineers:
            by_region[e.get("region")] = by_region.get(e.get("region"), 0) + 1

        misses = []
        for l in s.get("locker_status", []):
            if l.get("pre_8am_delivered"):
                l.pop("miss_reason", None)
                continue
            if not l.get("miss_reason"):
                l["miss_reason"] = ("over_capacity" if (l.get("fill_pct") or 0) > 85
                                    else random.choice(["carrier_missed_cutoff", "comms_loss",
                                                        "carrier_missed_cutoff", "wave_not_loaded"]))
            region_pool = max(1, by_region.get(l.get("region"), 8))
            affected = max(1, min(region_pool, round(region_pool * _rnd(0.02, 0.08, 3))))
            reason = LOCKER_MISS_REASONS[l["miss_reason"]]
            first_job = l.get("first_job_at") or f"{random.choice([8, 8, 9]):02d}:{random.choice(['00', '15', '30'])}"
            l["first_job_at"] = first_job
            misses.append({
                "site_code": l["bybox_site_code"], "name": l.get("name"),
                "region": l.get("region"), "postcode": l.get("postcode"),
                "latitude": l.get("latitude"), "longitude": l.get("longitude"),
                "fill_pct": l.get("fill_pct"), "total_slots": l.get("total_slots"),
                "items_available": l.get("items_available"),
                "reason": l["miss_reason"], "reason_label": reason["label"],
                "reason_detail": reason["detail"],
                "recoverable_same_day": reason["recoverable_same_day"],
                "engineers_affected": affected,
                "jobs_at_risk": affected * random.randint(1, 3),
                "first_job_at": first_job,
                "severity": ("high" if affected >= 4 or l["miss_reason"] == "wave_not_loaded"
                             else "medium"),
                "status": l.get("miss_status", "open"),
                "resolution": l.get("miss_resolution"),
            })
        misses.sort(key=lambda m: ({"high": 0, "medium": 1}.get(m["severity"], 2), -m["engineers_affected"]))
        s["locker_misses"] = misses
        return misses

    def locker_misses(self, *, region: str | None = None, include_options: bool = False) -> list[dict]:
        rows = self._state().get("locker_misses", [])
        if region:
            rows = [m for m in rows if m.get("region") == region]
        if include_options:
            return [{**m, "options": self.locker_miss_options(m)} for m in rows]
        return rows

    def locker_miss_options(self, miss: dict) -> list[dict]:
        if miss.get("status") == "resolved":
            return []
        lat, lon = miss.get("latitude"), miss.get("longitude")
        alt = self._nearest_locker(lat, lon, exclude=(miss["site_code"],))
        hub = self._nearest_hub(lat, lon)
        alt_miles = miles_between(lat, lon, alt.get("latitude"), alt.get("longitude")) if alt else 999.0
        hub_miles = miles_between(lat, lon, hub.get("latitude"), hub.get("longitude")) if hub else 999.0
        eng_n = miss["engineers_affected"]
        options = []

        # Re-point collections to the nearest healthy site — the standard first
        # move, and the only one that needs no new vehicle.
        if alt and alt_miles <= 25:
            detour = drive_mins(alt_miles)
            options.append(_opt(
                "failover_nearest_locker", "Fail over to nearest healthy site",
                f"Re-point {eng_n} engineer(s) to {alt['bybox_site_code']} — {alt_miles} mi",
                detail=(f"{alt['bybox_site_code']} is {alt_miles} mi away at {alt.get('fill_pct', 0):.0f}% fill "
                        f"and confirmed for this morning. Collections and unlock codes move across; "
                        f"engineers are notified before they travel."),
                eta_mins=detour, cost_gbp=eng_n * alt_miles * 0.18,
                sla_impact=f"+{detour} min per engineer", confidence=86, recommended=True,
                autonomy="auto", threshold_key="locker_failover",
                consequence="Adds a detour to each affected round; no new delivery is bought.",
                alt_site_code=alt["bybox_site_code"], distance_miles=alt_miles))
        else:
            options.append(_opt(
                "failover_nearest_locker", "Fail over to nearest healthy site",
                "No healthy site inside a workable detour", available=False,
                unavailable_reason="Nearest healthy locker is beyond a 25-mile detour.",
                autonomy="auto", threshold_key="locker_failover"))

        # Master-key override — only meaningful when the stock is believed to be
        # there and it is the confirmation that failed.
        comms = miss["reason"] == "comms_loss"
        options.append(_opt(
            "master_key_override", "Issue master-key override",
            "Let engineers open the site without telemetry confirmation" if comms
            else "Only valid when telemetry, not the delivery, has failed",
            detail=("Telemetry is down but the wave is believed delivered. A time-boxed master-key "
                    "code lets the affected engineers open the site and self-declare what they took; "
                    "stock is reconciled when the site comes back."),
            available=comms,
            unavailable_reason=None if comms else f"Cause is '{LOCKER_MISS_REASONS[miss['reason']]['label']}' — there is nothing in the locker to open.",
            eta_mins=10, cost_gbp=0.0, sla_impact="No delay", confidence=74,
            recommended=comms, autonomy="human", threshold_key="locker_master_key",
            consequence="Stock accuracy at this site is unverified until it is reconciled."))

        # Second-wave courier — buys a same-day catch-up drop. Real money, so it
        # earns its place only when the miss is same-day recoverable.
        same_day = miss["recoverable_same_day"]
        options.append(_opt(
            "second_wave_courier", "Book a same-day catch-up drop",
            f"Dedicated courier from {hub.get('name') if hub else 'the nearest hub'} — {hub_miles} mi",
            detail=("Books a same-day dedicated leg from the hub into this site so the engineers "
                    "collect late rather than not at all. Appears in Transport Control as a tracked "
                    "third-party movement."),
            available=bool(hub) and same_day,
            unavailable_reason=None if (hub and same_day) else "The wave was never loaded — there is nothing at the hub to run out.",
            eta_mins=drive_mins(hub_miles) + 45,
            cost_gbp=SERVICE_META["same_day"]["cost_base"] + hub_miles * 1.15,
            sla_impact="Collection slips to late morning", confidence=82,
            recommended=same_day and eng_n >= 4,
            autonomy="human", threshold_key="locker_second_wave",
            consequence="Premium same-day freight; the morning's first appointments still move.",
            hub_code=hub.get("code") if hub else None, distance_miles=hub_miles))

        # Divert to the hub trade counter — no new vehicle, engineer absorbs the trip.
        options.append(_opt(
            "divert_to_hub_collection", "Divert to hub trade counter",
            f"Send engineers to {hub.get('name') if hub else '—'} — {hub_miles} mi",
            detail=("Trade-counter collection from the hub itself. No delivery is bought and stock is "
                    "certain, but the detour is longer than a locker failover and lands on every "
                    "affected engineer."),
            available=bool(hub) and hub_miles <= 40,
            unavailable_reason=None if (hub and hub_miles <= 40) else "Nearest hub is too far to absorb into the morning.",
            eta_mins=drive_mins(hub_miles) + 15,
            cost_gbp=eng_n * hub_miles * 0.18,
            sla_impact=f"+{drive_mins(hub_miles) + 15} min per engineer", confidence=88,
            autonomy="auto", threshold_key="locker_hub_collection",
            consequence="Longest detour of the options, but stock is guaranteed.",
            hub_code=hub.get("code") if hub else None, distance_miles=hub_miles))

        # In-boot switch — the forward fix for tomorrow, not today.
        options.append(_opt(
            "switch_to_in_boot", "Switch site to in-boot delivery",
            f"Move {eng_n} engineer(s) to overnight boot-drop from tomorrow",
            detail=("Re-points tomorrow's wave for these engineers away from the locker and into "
                    "their vans overnight. Removes the dependency on this site while it is unstable; "
                    "does nothing for this morning."),
            eta_mins=None, cost_gbp=eng_n * SERVICE_META["in_boot"]["cost_base"],
            sla_impact="Effective from tomorrow 06:30", confidence=91,
            autonomy="auto", threshold_key="locker_in_boot_switch",
            consequence="Higher unit cost per drop than a locker for as long as it is left on."))

        # Provider ticket — starts the SLA clock and the credit claim.
        options.append(_opt(
            "raise_provider_ticket", "Raise ByBox NOC ticket",
            "Start the availability-SLA clock and the credit claim",
            detail=("Logs the miss with the provider's NOC, demands a restoration ETA and preserves "
                    "the contractual claim for the engineer hours lost. Does not move any stock."),
            eta_mins=None, cost_gbp=0.0, sla_impact="No operational effect",
            confidence=97, autonomy="auto", threshold_key="locker_provider_ticket",
            consequence="Commercial record only — pair it with an operational option."))

        return _rank(options)

    def resolve_locker_miss(self, site_code: str, action: str, by: str,
                            params: dict | None = None) -> dict:
        params = params or {}
        s = self._state()
        miss = next((m for m in s.get("locker_misses", []) if m["site_code"] == site_code), None)
        locker = next((l for l in s.get("locker_status", []) if l["bybox_site_code"] == site_code), None)
        if not miss or not locker:
            return {"error": "No open pre-8AM miss at this site"}
        option = next((o for o in self.locker_miss_options(miss) if o["action"] == action), None)
        if not option:
            return {"error": f"Unknown action '{action}'"}
        if not option["available"]:
            return {"error": option["unavailable_reason"] or "Action not available in the current state"}

        summary = option["label"]
        extra: dict = {}

        if action == "failover_nearest_locker":
            locker["failover_site"] = option["alt_site_code"]
            locker["pre_8am_delivered"] = True
            locker["status"] = "healthy"
            summary = (f"{miss['engineers_affected']} engineer(s) re-pointed to "
                       f"{option['alt_site_code']} (+{option['eta_mins']} min each)")
        elif action == "master_key_override":
            locker["master_key_issued"] = True
            locker["master_key_expires_at"] = _iso(_now() + timedelta(hours=4))
            locker["pre_8am_delivered"] = True
            locker["status"] = "healthy"
            locker["stock_reconciliation_due"] = True
            summary = f"Master-key override issued to {miss['engineers_affected']} engineer(s) for 4 hours"
            extra["expires_at"] = locker["master_key_expires_at"]
        elif action == "second_wave_courier":
            mv = self.book_carrier_movement(
                origin_code=option["hub_code"], dest_type="locker", dest_code=site_code,
                service="same_day",
                lines=[{"sku_code": c, "description": d, "quantity": random.randint(2, 8)}
                       for c, d in random.sample(FORWARD_PARTS, k=2)],
                reason="Pre-8AM catch-up wave", by=by)
            locker["second_wave_ref"] = mv.get("movement_ref")
            locker["pre_8am_delivered"] = True
            locker["status"] = "healthy"
            summary = (f"Same-day catch-up drop {mv.get('movement_ref')} booked from "
                       f"{option['hub_code']} — ETA {mv.get('eta_label', '—')}")
            extra["movement_ref"] = mv.get("movement_ref")
        elif action == "divert_to_hub_collection":
            locker["diverted_to_hub"] = option["hub_code"]
            locker["pre_8am_delivered"] = True
            locker["status"] = "healthy"
            summary = (f"{miss['engineers_affected']} engineer(s) diverted to {option['hub_code']} "
                       f"trade counter (+{option['eta_mins']} min each)")
        elif action == "switch_to_in_boot":
            locker["delivery_mode"] = "in_boot"
            locker["in_boot_from"] = (_now() + timedelta(days=1)).date().isoformat()
            summary = f"{miss['engineers_affected']} engineer(s) switched to in-boot from tomorrow"
            extra["effective_from"] = locker["in_boot_from"]
        elif action == "raise_provider_ticket":
            ticket = f"BYB-NOC-{random.randint(40000, 99999)}"
            call = self._post_outbound(
                "ByBox NOC · Incident",
                "POST https://noc.bybox.net/api/v2/incidents",
                {"site_code": site_code, "category": miss["reason"],
                 "engineers_affected": miss["engineers_affected"],
                 "sla": "pre_8am_availability", "raised_by": by})
            locker["provider_ticket"] = ticket
            locker["provider_ticket_at"] = call["at"]
            summary = f"NOC ticket {ticket} raised — availability SLA clock started"
            extra.update({"ticket": ticket, "endpoint": call["endpoint"]})

        locker["miss_status"] = "resolved"
        locker["miss_resolution"] = {
            "action": action, "label": option["label"], "by": by, "at": _iso(_now()),
            "summary": summary, "cost_gbp": option["cost_gbp"], **extra}
        self.hold_entity("locker_telemetry", f"locker:{site_code}")
        self._res_log("locker_miss", site_code, action, by, summary,
                      threshold_key=option["threshold_key"],
                      severity=miss["severity"], cost_gbp=option["cost_gbp"])
        self.refresh_locker_misses()
        self._sync_derived_state()
        return {"resolved": True, "site_code": site_code, **locker["miss_resolution"]}

    # ═════════════════════════════════════════════════════════════════════════
    # 3 · THIRD-PARTY CARRIER MOVEMENTS
    # ═════════════════════════════════════════════════════════════════════════

    def gen_carrier_movements(self, count: int = 34) -> list[dict]:
        """Hub → forward-location legs run by third-party carriers.

        Three destination types, because the part decides the channel: small
        parts go to a locker for pre-8AM collection or into the engineer's boot
        overnight; anything bulky (outdoor units, cylinders, full boiler swaps)
        cannot do either and is delivered two-man to the job address on the day.
        """
        s = self._snapshot
        hubs = s.get("warehouse_status", []) or []
        lockers = s.get("locker_status", []) or []
        engineers = s.get("engineer_locations", []) or []
        routes = s.get("engineer_routes", {}) or {}
        if not hubs:
            return []

        out = []
        for i in range(count):
            hub = random.choice(hubs)
            dest_type = random.choices(["locker", "in_boot", "job_site"], weights=[0.5, 0.28, 0.22])[0]
            eng = random.choice(engineers) if engineers else None

            if dest_type == "job_site":
                sku, desc, weight = random.choice(BULKY_PARTS)
                service = "two_man"
                lines = [{"sku_code": sku, "description": desc, "quantity": 1}]
                route = routes.get(eng["engineer_code"]) if eng else None
                stop = next(iter(drivable((route or {}).get("stops", []))), None)
                dest_code = stop.get("job_code") if stop else f"JOB-{random.randint(40000, 89999)}"
                dest_name = f"Customer address · {stop.get('postcode') if stop else 'TBC'}"
                lat = stop.get("latitude") if stop else (eng or {}).get("latitude")
                lon = stop.get("longitude") if stop else (eng or {}).get("longitude")
                postcode = stop.get("postcode") if stop else None
                pieces, weight_kg = 1, weight
            elif dest_type == "locker":
                locker = random.choice(lockers) if lockers else None
                service = "pre_8am"
                lines = [{"sku_code": c, "description": d, "quantity": random.randint(1, 6)}
                         for c, d in random.sample(FORWARD_PARTS, k=random.randint(1, 3))]
                dest_code = locker["bybox_site_code"] if locker else "BBX-UNKNOWN"
                dest_name = locker.get("name") if locker else "ByBox site"
                lat, lon = (locker or {}).get("latitude"), (locker or {}).get("longitude")
                postcode = (locker or {}).get("postcode")
                pieces = sum(l["quantity"] for l in lines)
                weight_kg = round(pieces * _rnd(0.8, 3.5), 1)
            else:
                service = "in_boot"
                lines = [{"sku_code": c, "description": d, "quantity": random.randint(1, 4)}
                         for c, d in random.sample(FORWARD_PARTS, k=random.randint(1, 2))]
                dest_code = eng["engineer_code"] if eng else "ENG-UNKNOWN"
                dest_name = f"{eng['name']}'s van" if eng else "Engineer van"
                lat, lon = (eng or {}).get("latitude"), (eng or {}).get("longitude")
                postcode = (eng or {}).get("home_postcode")
                pieces = sum(l["quantity"] for l in lines)
                weight_kg = round(pieces * _rnd(0.8, 3.5), 1)

            carrier = random.choice([c for c in CARRIERS if service in c["services"]])
            booked = _now() - timedelta(hours=_rnd(2, 20))
            promised = self._promise_for(service, booked)
            # Roughly one in four legs is running late — the mix a real carrier
            # base produces once you include a bulky specialist.
            late = random.random() < (0.34 if service == "two_man" else 0.22)
            delay = random.randint(25, 260) if late else 0
            status = self._status_for(booked, promised, delay)
            # A tracking board with nothing completed on it reads as broken, so
            # a share of the board is yesterday's work that landed cleanly.
            if not late and random.random() < 0.28:
                status = "delivered"
                booked = booked - timedelta(days=1)
                promised = self._promise_for(service, booked)

            out.append({
                "movement_ref": f"TPC-{2026000 + i}",
                "carrier_code": carrier["code"], "carrier": carrier["name"],
                "backup_carrier_code": carrier["backup"],
                "backup_carrier": CARRIER_BY_CODE[carrier["backup"]]["name"],
                "service": service, "service_label": SERVICE_META[service]["label"],
                "origin_type": "hub", "origin_code": hub["code"], "origin_name": hub.get("name"),
                # Both ends carry coordinates so the leg can be drawn without the
                # client having to join back to the warehouse list.
                "origin_latitude": hub.get("latitude"), "origin_longitude": hub.get("longitude"),
                "dest_type": dest_type, "dest_code": dest_code, "dest_name": dest_name,
                "dest_postcode": postcode, "latitude": lat, "longitude": lon,
                "region": (eng or {}).get("region") if dest_type != "locker"
                          else next((l.get("region") for l in lockers if l["bybox_site_code"] == dest_code), None),
                "is_bulky": service == "two_man",
                "lines": lines, "pieces": pieces, "weight_kg": weight_kg,
                "linked_engineer_code": eng["engineer_code"] if eng else None,
                "linked_engineer_name": eng.get("name") if eng else None,
                "linked_job_code": dest_code if dest_type == "job_site" else None,
                "booked_at": _iso(booked), "promised_at": _iso(promised),
                "eta": _iso(promised + timedelta(minutes=delay)),
                "delay_mins": delay, "status": status,
                "sla_at_risk": delay > 0 and status != "delivered",
                "cost_gbp": round(SERVICE_META[service]["cost_base"] + weight_kg * _rnd(0.2, 0.7), 2),
                "milestones": self._milestones(booked, status, carrier["name"], hub.get("name")),
                "resolution": None,
            })
        s["carrier_movements"] = out
        return out

    @staticmethod
    def _promise_for(service: str, booked: datetime) -> datetime:
        if service in ("pre_8am", "in_boot"):
            hour = 7 if service == "pre_8am" else 6
            promise = (booked + timedelta(days=1)).replace(hour=hour, minute=0, second=0, microsecond=0)
        elif service == "same_day":
            promise = booked + timedelta(hours=4)
        elif service == "two_man":
            promise = (booked + timedelta(days=1)).replace(
                hour=random.choice([9, 11, 13, 15]), minute=0, second=0, microsecond=0)
        else:
            promise = (booked + timedelta(days=1)).replace(hour=12, minute=0, second=0, microsecond=0)
        return promise

    @staticmethod
    def _status_for(booked: datetime, promised: datetime, delay: int) -> str:
        now = _now()
        eta = promised + timedelta(minutes=delay)
        if now >= eta and delay == 0:
            return "delivered"
        if delay >= 120:
            return "delayed"
        elapsed = (now - booked).total_seconds()
        window = max(1.0, (promised - booked).total_seconds())
        frac = elapsed / window
        if delay and frac > 0.6:
            return "delayed"
        if frac < 0.2:
            return "booked"
        if frac < 0.5:
            return "collected"
        if frac < 0.85:
            return "in_transit"
        return "out_for_delivery"

    @staticmethod
    def _milestones(booked: datetime, status: str, carrier: str, origin: str | None) -> list[dict]:
        flow = [
            ("booked", f"Consignment booked with {carrier}", origin or "Hub"),
            ("collected", "Collected from hub", origin or "Hub"),
            ("in_transit", "Departed carrier depot", f"{carrier} network"),
            ("out_for_delivery", "Out for delivery", "Delivery round"),
            ("delivered", "Delivered", "Destination"),
        ]
        idx = MOVEMENT_STATUS_FLOW.index(status) if status in MOVEMENT_STATUS_FLOW else 2
        out = []
        for i, (key, event, where) in enumerate(flow[: idx + 1]):
            out.append({"at": _iso(booked + timedelta(hours=i * 1.6)), "event": event,
                        "location": where, "key": key})
        if status == "delayed":
            out.append({"at": _iso(_now() - timedelta(minutes=random.randint(10, 90))),
                        "event": "Delay reported by carrier", "location": f"{carrier} control tower",
                        "key": "delayed"})
        return out

    def advance_carrier_movements(self) -> int:
        """One carrier-tracking cycle: milestones progress, ETAs drift, and a
        small number of previously-clean legs start slipping."""
        s = self._snapshot
        moved = 0
        for mv in s.get("carrier_movements", []):
            if mv["status"] == "delivered" or self.is_held("carrier_movement", mv["movement_ref"]):
                continue
            # ETA drift: carriers re-publish an estimate, they do not hold one.
            if mv["delay_mins"] or random.random() < 0.18:
                drift = random.randint(-8, 14)
                mv["delay_mins"] = max(0, mv["delay_mins"] + drift)
                promised = datetime.fromisoformat(mv["promised_at"])
                mv["eta"] = _iso(promised + timedelta(minutes=mv["delay_mins"]))
            # A clean leg occasionally turns bad — that is what the delay queue is for.
            if not mv["delay_mins"] and random.random() < 0.04:
                mv["delay_mins"] = random.randint(35, 180)
                mv["eta"] = _iso(datetime.fromisoformat(mv["promised_at"])
                                 + timedelta(minutes=mv["delay_mins"]))
                mv["milestones"].append({
                    "at": _iso(_now()), "event": "Delay reported by carrier",
                    "location": f"{mv['carrier']} control tower", "key": "delayed"})
            # Milestone progression.
            if mv["status"] in MOVEMENT_STATUS_FLOW and random.random() < 0.35:
                i = MOVEMENT_STATUS_FLOW.index(mv["status"])
                if i < len(MOVEMENT_STATUS_FLOW) - 1:
                    mv["status"] = MOVEMENT_STATUS_FLOW[i + 1]
                    mv["milestones"].append({
                        "at": _iso(_now()),
                        "event": {"collected": "Collected from hub",
                                  "in_transit": "Departed carrier depot",
                                  "out_for_delivery": "Out for delivery",
                                  "delivered": "Delivered"}[mv["status"]],
                        "location": mv["dest_name"] if mv["status"] == "delivered" else f"{mv['carrier']} network",
                        "key": mv["status"]})
                    moved += 1
            if mv["delay_mins"] >= 120 and mv["status"] != "delivered":
                mv["status"] = "delayed"
            mv["sla_at_risk"] = mv["delay_mins"] > 0 and mv["status"] != "delivered"
        return moved

    def book_carrier_movement(self, *, origin_code: str | None, dest_type: str, dest_code: str,
                              service: str, lines: list[dict], reason: str, by: str,
                              linked_engineer_code: str | None = None,
                              linked_job_code: str | None = None) -> dict:
        """Book a new third-party leg. Used directly by the operator and by other
        resolutions (a locker catch-up drop, a van replenishment wave)."""
        s = self._snapshot
        hub = next((h for h in self._hubs() if h["code"] == origin_code), None) or (self._hubs() or [None])[0]
        if hub is None:
            return {"error": "No hub available to ship from"}
        carrier = random.choice([c for c in CARRIERS if service in c["services"]])
        booked = _now()
        promised = self._promise_for(service, booked)
        pieces = sum(l.get("quantity", 1) for l in lines) or 1
        weight = round(pieces * _rnd(0.8, 3.5), 1) if service != "two_man" else _rnd(30, 95)

        locker = next((l for l in s.get("locker_status", []) if l["bybox_site_code"] == dest_code), None)
        eng = self._engineer(linked_engineer_code) if linked_engineer_code else None
        mv = {
            "movement_ref": f"TPC-{2026000 + len(s.get('carrier_movements', [])) + 1}",
            "carrier_code": carrier["code"], "carrier": carrier["name"],
            "backup_carrier_code": carrier["backup"],
            "backup_carrier": CARRIER_BY_CODE[carrier["backup"]]["name"],
            "service": service, "service_label": SERVICE_META[service]["label"],
            "origin_type": "hub", "origin_code": hub["code"], "origin_name": hub.get("name"),
            "origin_latitude": hub.get("latitude"), "origin_longitude": hub.get("longitude"),
            "dest_type": dest_type, "dest_code": dest_code,
            "dest_name": (locker.get("name") if locker else
                          (f"{eng['name']}'s van" if eng and dest_type == "in_boot" else dest_code)),
            "dest_postcode": (locker or {}).get("postcode") or (eng or {}).get("home_postcode"),
            "latitude": (locker or eng or {}).get("latitude"),
            "longitude": (locker or eng or {}).get("longitude"),
            "region": (locker or eng or {}).get("region"),
            "is_bulky": service == "two_man",
            "lines": lines, "pieces": pieces, "weight_kg": weight,
            "linked_engineer_code": linked_engineer_code,
            "linked_engineer_name": eng.get("name") if eng else None,
            "linked_job_code": linked_job_code,
            "booked_at": _iso(booked), "promised_at": _iso(promised), "eta": _iso(promised),
            "eta_label": promised.strftime("%H:%M"),
            "delay_mins": 0, "status": "booked", "sla_at_risk": False,
            "cost_gbp": round(SERVICE_META[service]["cost_base"] + weight * _rnd(0.2, 0.7), 2),
            "milestones": [{"at": _iso(booked), "event": f"Consignment booked with {carrier['name']}",
                            "location": hub.get("name"), "key": "booked"}],
            "booked_by": by, "booking_reason": reason, "resolution": None}
        s.setdefault("carrier_movements", []).insert(0, mv)
        self.hold_entity("carrier_tracking", f"carrier_movement:{mv['movement_ref']}")
        self._post_outbound(
            f"{carrier['name']} · Booking API",
            f"POST https://api.{carrier['code'].lower()}.carrier.net/v1/consignments",
            {"reference": mv["movement_ref"], "service": service,
             "collection": hub["code"], "delivery": dest_code,
             "pieces": pieces, "weight_kg": weight, "reason": reason})
        return mv

    def carrier_movements(self, *, status: str | None = None, dest_type: str | None = None,
                          include_options: bool = False) -> list[dict]:
        rows = self._state().get("carrier_movements", [])
        if status == "delayed":
            rows = [m for m in rows if m.get("delay_mins", 0) > 0 and m.get("status") != "delivered"]
        elif status and status != "all":
            rows = [m for m in rows if m.get("status") == status]
        if dest_type and dest_type != "all":
            rows = [m for m in rows if m.get("dest_type") == dest_type]
        rows = sorted(rows, key=lambda m: (-(m.get("delay_mins") or 0), m.get("promised_at") or ""))
        if include_options:
            return [{**m, "options": self.carrier_options(m)} for m in rows]
        return rows

    def carrier_options(self, mv: dict) -> list[dict]:
        if mv.get("resolution") or mv.get("status") == "delivered" or not mv.get("delay_mins"):
            return []
        delay = mv["delay_mins"]
        bulky = mv["is_bulky"]
        backup = mv["backup_carrier"]
        options = []

        # Escalate with the incumbent — cheapest, and the only move that needs no
        # replanning. Recovers a share of the delay, never all of it.
        options.append(_opt(
            "escalate_carrier", "Escalate to carrier control tower",
            f"Demand priority handling and a firm ETA from {mv['carrier']}",
            detail=(f"Raises the consignment with {mv['carrier']}'s control tower, requests priority "
                    f"handling on the remaining leg and pins them to a committed ETA. Typically "
                    f"recovers 30–50% of the slip on a leg still inside the network."),
            eta_mins=-max(10, round(delay * 0.4)),
            cost_gbp=0.0, sla_impact=f"Recovers ~{round(delay * 0.4)} min", confidence=72,
            recommended=delay < 90,
            autonomy="auto", threshold_key="carrier_escalate",
            consequence="No cost, but it depends on the carrier honouring the commitment."))

        # Switch to the standing backup — the contingency the contract exists for.
        options.append(_opt(
            "switch_backup_carrier", f"Re-book with {backup}",
            "Move the remaining leg to the standby carrier",
            detail=(f"Cancels the leg with {mv['carrier']} and re-books it under the standing backup "
                    f"agreement with {backup}. Worth it when the incumbent has lost control of the "
                    f"consignment rather than merely run late."),
            available=mv["status"] in ("booked", "collected", "delayed"),
            unavailable_reason=None if mv["status"] in ("booked", "collected", "delayed")
            else "The consignment is already out for delivery — a re-book would land later than the delay.",
            eta_mins=-max(20, round(delay * 0.65)),
            cost_gbp=round(mv["cost_gbp"] * 0.85, 2),
            sla_impact=f"Recovers ~{round(delay * 0.65)} min", confidence=78,
            recommended=delay >= 90 and mv["status"] in ("booked", "collected", "delayed"),
            autonomy="human", threshold_key="carrier_switch",
            consequence="Pays a second freight charge; the original leg is cancelled, not refunded."))

        # Split the critical lines onto a dedicated same-day — bulky can't split.
        options.append(_opt(
            "split_critical_lines", "Split critical lines to same-day",
            "Dedicated courier for what today's jobs need; the rest follows",
            detail=("Pulls only the lines booked against today's jobs onto a dedicated same-day "
                    "courier and lets the balance run late. Protects the appointments without "
                    "paying premium freight on the whole consignment."),
            available=not bulky and len(mv["lines"]) > 1,
            unavailable_reason=("A two-man bulky consignment is a single indivisible unit." if bulky
                                else "Single-line consignment — there is nothing to split."),
            eta_mins=-max(30, round(delay * 0.8)),
            cost_gbp=SERVICE_META["same_day"]["cost_base"],
            sla_impact="Today's jobs covered", confidence=85,
            recommended=not bulky and len(mv["lines"]) > 1 and delay >= 120,
            autonomy="human", threshold_key="carrier_split"))

        # Re-point to somewhere the engineer can reach instead.
        alt = self._nearest_locker(mv.get("latitude"), mv.get("longitude"),
                                   exclude=(mv.get("dest_code"),))
        alt_miles = miles_between(mv.get("latitude"), mv.get("longitude"),
                                  (alt or {}).get("latitude"), (alt or {}).get("longitude")) if alt else 999.0
        options.append(_opt(
            "divert_dropoff", "Divert to an alternative drop-off",
            f"Re-point to {alt['bybox_site_code'] if alt else '—'} — {alt_miles} mi",
            detail=("Changes the delivery point to a site the carrier can still make inside the "
                    "window, and moves the engineer to meet it there."),
            available=bool(alt) and not bulky and alt_miles <= 25,
            unavailable_reason=("Bulky goods are delivered to the job address — there is nowhere else "
                                "to divert them." if bulky else "No alternative drop-off inside a workable detour."),
            eta_mins=-max(15, round(delay * 0.5)),
            cost_gbp=alt_miles * 0.18,
            sla_impact=f"Recovers ~{round(delay * 0.5)} min, adds a detour", confidence=76,
            autonomy="auto", threshold_key="carrier_divert",
            alt_site_code=(alt or {}).get("bybox_site_code"), distance_miles=alt_miles))

        # Give up on the leg and cover from hub stock instead.
        hub = self._nearest_hub(mv.get("latitude"), mv.get("longitude"))
        options.append(_opt(
            "cover_from_hub", "Cover the job from hub stock",
            f"Pull cover from {hub.get('name') if hub else 'the nearest hub'} and let the leg land late",
            detail=("Stops waiting on the consignment: the job is covered from stock already at the "
                    "nearest hub and the late leg simply replenishes when it arrives."),
            available=bool(hub) and not bulky,
            unavailable_reason=("Bulky units are not held at hubs as free stock." if bulky
                                else "No hub available to cover from."),
            eta_mins=-delay, cost_gbp=45.0,
            sla_impact="Job protected in full", confidence=81,
            recommended=bool(hub) and not bulky and delay >= 180,
            autonomy="auto", threshold_key="carrier_cover_from_hub",
            hub_code=(hub or {}).get("code")))

        # Move the customer instead of the parts.
        options.append(_opt(
            "rebook_job", "Rebook the appointment",
            "Move the customer slot to match the realistic ETA",
            detail=("Where the part genuinely cannot arrive in time, contacting the customer first "
                    "and rebooking to a slot the ETA supports costs far less than a failed visit "
                    "and a second truck roll."),
            available=bool(mv.get("linked_job_code")),
            unavailable_reason=None if mv.get("linked_job_code") else "No customer appointment is linked to this leg.",
            eta_mins=None, cost_gbp=0.0,
            sla_impact="SLA re-baselined with the customer", confidence=88,
            recommended=bulky and delay >= 180,
            autonomy="human", threshold_key="carrier_rebook_job",
            consequence="Counts as a rescheduled appointment in the first-time-fix measure."))

        # Commercial record.
        options.append(_opt(
            "claim_sla_credit", "Log against the carrier SLA",
            f"Record the {delay} min slip for penalty recovery",
            detail=("Files the failure against the carrier's on-time SLA so the cost of the "
                    "disruption is recoverable at the next rate review. Changes nothing operationally."),
            eta_mins=None, cost_gbp=0.0, sla_impact="No operational effect", confidence=96,
            autonomy="auto", threshold_key="carrier_sla_claim",
            consequence="Commercial record only — pair it with an operational option."))

        return _rank(options)

    def resolve_carrier_movement(self, movement_ref: str, action: str, by: str,
                                 params: dict | None = None) -> dict:
        params = params or {}
        s = self._state()
        mv = next((m for m in s.get("carrier_movements", []) if m["movement_ref"] == movement_ref), None)
        if not mv:
            return {"error": "Movement not found"}
        option = next((o for o in self.carrier_options(mv) if o["action"] == action), None)
        if not option:
            return {"error": f"Unknown action '{action}'"}
        if not option["available"]:
            return {"error": option["unavailable_reason"] or "Action not available in the current state"}

        before = mv["delay_mins"]
        summary, extra = option["label"], {}

        def _recover(mins: int):
            mv["delay_mins"] = max(0, mv["delay_mins"] - mins)
            mv["eta"] = _iso(datetime.fromisoformat(mv["promised_at"])
                             + timedelta(minutes=mv["delay_mins"]))
            mv["sla_at_risk"] = mv["delay_mins"] > 0
            if mv["delay_mins"] < 120 and mv["status"] == "delayed":
                mv["status"] = "in_transit"

        if action == "escalate_carrier":
            _recover(round(before * 0.4))
            mv["escalated_to_carrier"] = True
            summary = f"Escalated to {mv['carrier']} — delay {before} → {mv['delay_mins']} min"
            self._post_outbound(
                f"{mv['carrier']} · Control Tower",
                f"POST https://api.{mv['carrier_code'].lower()}.carrier.net/v1/consignments/{movement_ref}/escalate",
                {"reference": movement_ref, "reason": "SLA at risk", "raised_by": by})
        elif action == "switch_backup_carrier":
            _recover(round(before * 0.65))
            mv["carrier_code"], mv["carrier"] = mv["backup_carrier_code"], mv["backup_carrier"]
            mv["status"] = "booked"
            mv["milestones"].append({"at": _iso(_now()),
                                     "event": f"Re-booked with {mv['carrier']} under standby agreement",
                                     "location": mv["origin_name"], "key": "booked"})
            summary = f"Re-booked with {mv['carrier']} — delay {before} → {mv['delay_mins']} min"
        elif action == "split_critical_lines":
            critical = mv["lines"][:1]
            new_mv = self.book_carrier_movement(
                origin_code=mv["origin_code"], dest_type=mv["dest_type"], dest_code=mv["dest_code"],
                service="same_day", lines=critical,
                reason=f"Critical split from {movement_ref}", by=by,
                linked_engineer_code=mv.get("linked_engineer_code"),
                linked_job_code=mv.get("linked_job_code"))
            mv["lines"] = mv["lines"][1:]
            mv["pieces"] = sum(l.get("quantity", 1) for l in mv["lines"])
            mv["split_to"] = new_mv.get("movement_ref")
            summary = (f"{critical[0]['sku_code']} split onto same-day {new_mv.get('movement_ref')}; "
                       f"balance runs late")
            extra["movement_ref"] = new_mv.get("movement_ref")
        elif action == "divert_dropoff":
            _recover(round(before * 0.5))
            mv["dest_code"] = option["alt_site_code"]
            mv["dest_name"] = option["alt_site_code"]
            mv["diverted"] = True
            summary = f"Diverted to {option['alt_site_code']} — delay {before} → {mv['delay_mins']} min"
        elif action == "cover_from_hub":
            mv["covered_from_hub"] = option["hub_code"]
            mv["job_protected"] = True
            summary = f"Job covered from {option['hub_code']} stock; leg now replenishment only"
            if mv.get("linked_engineer_code"):
                eng = self._engineer(mv["linked_engineer_code"])
                if eng:
                    self._restock_van(eng)
                    self.hold_entity("van_stock", f"engineer:{eng['engineer_code']}")
        elif action == "rebook_job":
            new_slot = (datetime.fromisoformat(mv["eta"]) + timedelta(hours=2))
            mv["job_rebooked_to"] = _iso(new_slot)
            summary = f"{mv['linked_job_code']} rebooked to {new_slot.strftime('%d %b %H:%M')}"
            extra["rebooked_to"] = mv["job_rebooked_to"]
            self._post_outbound(
                "Salesforce Field Service · Scheduling",
                f"PATCH https://fs.centrica-svc.internal/api/v1/appointments/{mv['linked_job_code']}",
                {"job_code": mv["linked_job_code"], "new_slot": _iso(new_slot),
                 "reason": f"Carrier delay on {movement_ref}", "customer_notified": True, "by": by})
        elif action == "claim_sla_credit":
            claim = f"CLM-{random.randint(20000, 99999)}"
            mv["sla_claim_ref"] = claim
            summary = f"SLA claim {claim} filed against {mv['carrier']} for a {before} min slip"
            extra["claim_ref"] = claim

        mv["resolution"] = {"action": action, "label": option["label"], "by": by,
                            "at": _iso(_now()), "summary": summary,
                            "delay_before_mins": before, "delay_after_mins": mv["delay_mins"],
                            "cost_gbp": option["cost_gbp"], **extra}
        self.hold_entity("carrier_tracking", f"carrier_movement:{movement_ref}")
        self._res_log("carrier_delay", movement_ref, action, by, summary,
                      threshold_key=option["threshold_key"],
                      cost_gbp=option["cost_gbp"], delay_before_mins=before,
                      delay_after_mins=mv["delay_mins"])
        self._sync_derived_state()
        return {"resolved": True, "movement_ref": movement_ref, **mv["resolution"]}

    # ═════════════════════════════════════════════════════════════════════════
    # 4 · ARRIVAL RISK (engineer late to one or more jobs)
    # ═════════════════════════════════════════════════════════════════════════

    def refresh_route_eta_risk(self) -> list[dict]:
        """Project each live round forward and list the ones that will miss a
        booked slot. Delay is carried on the route so it persists and can be
        recovered by an action, rather than being re-rolled every cycle."""
        s = self._snapshot
        traffic = s.get("traffic_severity", "normal")
        # Share of live rounds expected to be running behind at any moment, and
        # how far behind. Modelled as a target OCCUPANCY rather than a per-cycle
        # coin flip: rounds recover as the plan's slack absorbs the slip, and the
        # engine only tops the queue back up to the level the road conditions
        # justify. A per-cycle probability would ratchet every round late inside
        # ten minutes, which is not what a normal Tuesday looks like.
        occupancy = {"normal": 0.10, "elevated": 0.18, "high": 0.28, "severe": 0.40}.get(traffic, 0.10)
        spread = {"normal": (12, 50), "elevated": (18, 75), "high": (25, 100), "severe": (35, 140)}[traffic]

        live: list[tuple[str, dict]] = []
        for code, route in (s.get("engineer_routes") or {}).items():
            eng = self._engineer(code)
            if not eng or eng.get("job_status") in ("off_duty", "break"):
                continue
            if drivable(route.get("stops", [])):
                live.append((code, route))

        # Recovery first: a delay decays as the round eats into its own slack.
        # Nothing is held here — `route_progress` declares no hold window, so a
        # round somebody has just acted on drifts with the traffic like any other.
        for code, route in live:
            if not route.get("delay_mins"):
                continue
            route["delay_mins"] = max(0, route["delay_mins"] + random.randint(-spread[0], spread[0] // 2))
            if route["delay_mins"] < 5:
                route["delay_mins"] = 0
                route["delay_cause"] = None

        # A resolution records what was done at a moment; it is not a permanent
        # label on the round. Because the round is no longer pinned, one that
        # slips materially past where the action left it has genuinely gone wrong
        # again — and must be free to raise a fresh risk rather than sit in the
        # list marked "resolved" over a delay nobody has acted on. Clearing the
        # marker loses nothing: what was done stays in `resolution_log`, which is
        # what the audit trail and the rounds-actioned-today count both read.
        for code, route in live:
            res = route.get("eta_resolution")
            if not res:
                continue
            settled = res.get("delay_after_mins") or 0
            if (route.get("delay_mins") or 0) >= max(10, settled + 10):
                route["eta_resolution"] = None
                route["_road_cache"] = None

        # Then top the queue back up to the level the conditions justify.
        late_now = [c for c, r in live if (r.get("delay_mins") or 0) >= 10]
        shortfall = round(len(live) * occupancy) - len(late_now)
        if shortfall > 0:
            clean = [(c, r) for c, r in live if not (r.get("delay_mins") or 0)]
            for code, route in random.sample(clean, k=min(shortfall, len(clean))):
                route["delay_mins"] = random.randint(*spread)
                route["delay_cause"] = random.choice(
                    ["traffic", "traffic", "job_overrun", "late_start", "vehicle_defect"])

        rows: list[dict] = []
        for code, route in live:
            eng = self._engineer(code)
            # Blocked stops are excluded deliberately: an engineer who was never
            # accredited to attend cannot be running late for it, and counting it
            # would raise an SLA breach against the wrong person.
            remaining = drivable(route.get("stops", []))
            delay = route.get("delay_mins") or 0
            if delay < 10:
                continue
            cause = route.get("delay_cause") or "traffic"
            if route.get("collections"):
                cause = "parts_collection"

            at_risk = []
            for st in remaining:
                deadline = st.get("sla_deadline") or add_mins(st.get("planned_arrival"), 60)
                projected = add_mins(st.get("planned_arrival"), delay)
                breach = mins_between(deadline, projected)
                if breach > 0:
                    at_risk.append({
                        "seq": st.get("seq"), "job_code": st.get("job_code"),
                        "job_type": st.get("job_type"), "postcode": st.get("postcode"),
                        "priority": st.get("priority", "standard"),
                        "planned_arrival": st.get("planned_arrival"),
                        "projected_arrival": projected, "sla_deadline": deadline,
                        "breach_mins": breach,
                        "latitude": st.get("latitude"), "longitude": st.get("longitude")})
            if not at_risk:
                continue

            van = self._van_for(code)
            worst = max(a["breach_mins"] for a in at_risk)
            sla_jobs = len([a for a in at_risk if a["priority"] in ("P1", "P2")])
            rows.append({
                "engineer_code": code, "engineer_name": eng.get("name"),
                "business_unit": eng.get("business_unit"), "region": eng.get("region"),
                "registration": van.get("registration") if van else None,
                "latitude": eng.get("latitude"), "longitude": eng.get("longitude"),
                "job_status": eng.get("job_status"),
                "delay_mins": delay, "cause": cause, "cause_label": ETA_CAUSES.get(cause, cause),
                "stops_remaining": len(remaining), "stops_at_risk": at_risk,
                "jobs_at_risk": len(at_risk), "sla_jobs_at_risk": sla_jobs,
                "worst_breach_mins": worst,
                "severity": ("critical" if sla_jobs and worst >= 45 else
                             "high" if sla_jobs or worst >= 45 else "medium"),
                "status": "resolved" if (route.get("eta_resolution") or {}).get("action") else "open",
                "resolution": route.get("eta_resolution"),
                "van_stock_low": eng.get("van_stock_low", False),
            })
        rows.sort(key=lambda r: ({"critical": 0, "high": 1, "medium": 2}.get(r["severity"], 3),
                                 -r["worst_breach_mins"]))
        s["route_eta_risk"] = rows
        return rows

    def eta_risks(self, *, region: str | None = None, include_options: bool = False) -> list[dict]:
        rows = self._state().get("route_eta_risk", [])
        if region:
            rows = [r for r in rows if r.get("region") == region]
        if include_options:
            return [{**r, "options": self.eta_risk_options(r)} for r in rows]
        return rows

    # ── Jobs at SLA risk — the cross-module roll-up ───────────────────────────

    def jobs_at_sla_risk(self, *, region: str | None = None) -> dict:
        """Today's jobs whose SLA is in jeopardy, and what is putting them there.

        Two independent failure modes cost the same appointment, and they are owned
        by two different modules:

          · the van will not ARRIVE in time            → Transport Control
          · the van will arrive without the PART       → Field Operations

        This has to be computed in one place, over job codes, because the two sets
        OVERLAP — a round that is running late is also disproportionately likely to
        be the round that is short of stock (`route_eta_risk` even carries
        `van_stock_low` for exactly that reason). Summing the two queue lengths
        client-side would double-count every job suffering both and report more jobs
        at risk than exist on the schedule. The union is the honest headline; the
        `both` count is what tells a dispatcher which jobs need two fixes, not one.

        `total_jobs` counts the appointments still OUTSTANDING, on the same two
        filters both causes above are computed on:

          · real appointments only — a parts-collection stop is the engineer's own
            errand, not a customer commitment, so it cannot breach an SLA
          · not yet completed — a job already done cannot go on to miss its window

        The second filter is what makes the ratio honest. Both numerator sets are
        built from remaining stops (`route_eta_risk` works off `remaining`, and the
        van-shortage pass skips completed stops), so counting the whole day's
        schedule underneath them measures a shrinking numerator against a fixed
        denominator: the figure would drift optimistic through the afternoon purely
        because work got finished, and read best at 5pm when the day's outcome is
        already fixed. Against outstanding work it means what it says — the share of
        what is LEFT that is currently in jeopardy, which is the only part of the day
        a dispatcher can still change.
        """
        s = self._state()
        routes = s.get("engineer_routes") or {}

        def in_scope(code: str) -> bool:
            if not region:
                return True
            eng = self._engineer(code)
            return bool(eng and eng.get("region") == region)

        total_jobs = 0
        for code, route in routes.items():
            if not in_scope(code):
                continue
            total_jobs += sum(1 for st in route.get("stops", [])
                              if st.get("stop_kind", "job") == "job"
                              and st.get("status") != "completed")

        # ── Cause 1 · arrival delay (Transport Control) ──
        delayed: set[str] = set()
        worst_breach = 0
        for r in s.get("route_eta_risk", []):
            if region and r.get("region") != region:
                continue
            if r.get("status") == "resolved":
                continue
            worst_breach = max(worst_breach, r.get("worst_breach_mins") or 0)
            for st in r.get("stops_at_risk", []):
                if st.get("job_code"):
                    delayed.add(st["job_code"])

        # ── Cause 2 · van parts shortage (Field Operations) ──
        # Only rounds carrying a line at ZERO count. Below-minimum-but-in-stock is a
        # replenishment trigger, not a service risk: the engineer still has the part
        # in the boot and the job still gets done. Counting those too would put ~5%
        # of the day's work permanently at risk on a normal Tuesday, and a headline
        # that is never green is a headline nobody reads.
        #
        # LIMITATION, stated because it bounds the number: there is no per-job bill
        # of materials in this model, so once a van is stocked out every remaining
        # appointment on that round is treated as exposed. The real figure is lower —
        # some of those jobs will not need the missing SKU. It is an upper bound on
        # one round, not a guess across the network.
        short: set[str] = set()
        for a in s.get("van_stock_alerts", []):
            if region and a.get("region") != region:
                continue
            if a.get("status") == "resolved":
                continue
            if not any((it.get("quantity") or 0) == 0 for it in a.get("shortfall", [])):
                continue
            route = routes.get(a.get("engineer_code")) or {}
            for st in route.get("stops", []):
                # A stop nobody on this van can legally work is not at risk
                # *from the van being short of a part* — it has its own problem.
                if not is_drivable(st) or st.get("stop_kind", "job") != "job":
                    continue
                if st.get("job_code"):
                    short.add(st["job_code"])

        at_risk = delayed | short
        both = delayed & short
        pct = round(len(at_risk) / total_jobs * 100, 1) if total_jobs else 0.0

        # ── Grading ──
        # Well above the 3% of the SLA BREACH target, and the difference is the point.
        # This is a LEADING indicator against which same-day recovery is still
        # available: every job counted here has an open van-alert or ETA-risk row
        # with costed recovery options attached, and most get worked before the
        # window closes. A normal day flags ~9–11% of outstanding work and breaches
        # under 1%. Setting the target at the breach rate would peg the card red every
        # day — the same trap a zero target sets for excess stock — and a headline that
        # is never green is a headline nobody reads.
        #
        # 8%, not the 5% this used to be, because the denominator changed underneath
        # it: the ratio is now taken against work still OUTSTANDING rather than the
        # whole day's schedule, and a denominator ~40% smaller needs a proportionally
        # wider band to mean the same thing. The rebase is deliberately calibrated on
        # the absolute bar rather than the percentage, which is what actually has to
        # stay put: 5% of ~802 scheduled and 8% of ~493 outstanding both put the
        # target at ~40 appointments, so the same number of at-risk jobs trips the
        # card as before. Only the unit the target is quoted in has changed.
        #
        # Note this ratio necessarily tightens as a day burns down — the same ten
        # at-risk jobs are a worse position against 50 remaining than against 500.
        # That is the honest reading of a leading indicator, not a defect: what is
        # being graded is the share of the work you can still save.
        target = 8.0
        rag = "G" if pct <= target else ("A" if pct <= target * 1.6 else "R")
        return {
            "rag": rag,
            "total_jobs": total_jobs,
            "at_risk": len(at_risk),
            "at_risk_pct": pct,
            # Attributable to one cause only — these two plus `both` sum to `at_risk`.
            "arrival_delay_only": len(delayed - short),
            "parts_shortage_only": len(short - delayed),
            "both_causes": len(both),
            # Total exposure per cause, for the module that owns it. These overlap
            # by `both_causes` and are NOT meant to be added together.
            "arrival_delay": len(delayed),
            "parts_shortage": len(short),
            "rounds_delayed": len({r["engineer_code"] for r in s.get("route_eta_risk", [])
                                   if (not region or r.get("region") == region)
                                   and r.get("status") != "resolved"}),
            "rounds_short_of_stock": len({a["engineer_code"] for a in s.get("van_stock_alerts", [])
                                          if (not region or a.get("region") == region)
                                          and a.get("status") != "resolved"
                                          and any((it.get("quantity") or 0) == 0
                                                  for it in a.get("shortfall", []))}),
            "worst_breach_mins": worst_breach,
            "target_pct": target,
            # The job count that percentage target allows for, so the card can state
            # the bar in the same unit as the figure above it.
            "target_jobs": int(total_jobs * target / 100),
        }

    def eta_risk_options(self, risk: dict) -> list[dict]:
        if risk.get("status") == "resolved":
            return []
        delay = risk["delay_mins"]
        worst = risk["stops_at_risk"][0] if risk["stops_at_risk"] else None
        options = []

        # Re-sequence what is left. Free and immediate — but only worth offering
        # if it actually recovers something, so the option is priced by running
        # the optimiser for real rather than by assuming a percentage. An option
        # that promises 20 minutes and delivers none is worse than no option.
        preview = self.reoptimise_round(risk["engineer_code"], apply=False)
        recover = max(0, (preview or {}).get("mins_saved") or 0)
        can_reroute = risk["stops_remaining"] >= 2 and recover > 0
        if risk["stops_remaining"] < 2:
            why_not = "Only one stop remains — there is nothing to re-sequence."
        elif recover <= 0:
            why_not = "The remaining stops are already in the best order available."
        else:
            why_not = None
        options.append(_opt(
            "reroute", "Re-optimise the remaining round",
            f"Re-sequence {risk['stops_remaining']} stop(s) around live traffic",
            detail=("Re-runs the optimiser over the remaining stops against the live traffic, the "
                    "parts each job still needs and the windows already committed to customers. "
                    + (f"On the current state it recovers {recover} min and "
                       f"{(preview or {}).get('miles_saved', 0)} mi."
                       if recover else "On the current state it finds nothing left to recover.")),
            available=can_reroute,
            unavailable_reason=why_not,
            eta_mins=-recover, cost_gbp=0.0,
            sla_impact=f"Recovers {recover} min" if recover else "No time recoverable",
            confidence=95,           # measured, not estimated
            recommended=can_reroute and delay < 45,
            autonomy="auto", threshold_key="eta_reroute",
            consequence="Later stops move; customers with a confirmed window need telling."))

        # Hand the job to whoever can actually make it.
        cover, cover_miles = self._nearest_capable_engineer(risk)
        options.append(_opt(
            "reallocate_job", "Reallocate the at-risk job",
            f"Move {worst['job_code'] if worst else 'the job'} to {cover['name'] if cover else '—'}"
            + (f" — {cover_miles} mi" if cover else ""),
            detail=(f"{cover['name']} is {cover_miles} mi from the address, holds the right "
                    f"accreditation and can make the window. The appointment stands as booked."
                    if cover else "No accredited engineer is close enough to make the window."),
            available=bool(cover) and bool(worst),
            unavailable_reason=None if (cover and worst) else "No accredited engineer within reach can make the window.",
            eta_mins=-(worst["breach_mins"] if worst else 0), cost_gbp=(cover_miles * 0.18) if cover else 0,
            sla_impact="Appointment protected", confidence=80,
            recommended=risk["severity"] == "critical" and bool(cover),
            autonomy="human", threshold_key="eta_reallocate",
            consequence="Changes two engineers' working day — dispatcher approval required.",
            cover_engineer_code=(cover or {}).get("engineer_code"),
            cover_engineer_name=(cover or {}).get("name"),
            job_code=worst["job_code"] if worst else None, distance_miles=cover_miles))

        # Tell the customer before they notice. Cheapest way to protect the
        # relationship when the minutes cannot be recovered.
        options.append(_opt(
            "notify_customer", "Send a revised arrival window",
            f"Proactively re-window {risk['jobs_at_risk']} customer(s)",
            detail=("Pushes an updated arrival window to every affected customer before the original "
                    "one lapses. It does not recover a minute, but a warned customer is not a "
                    "complaint and the visit still happens."),
            eta_mins=None, cost_gbp=0.0, sla_impact="Expectation reset, SLA still at risk",
            confidence=95, recommended=risk["severity"] != "critical",
            autonomy="auto", threshold_key="eta_notify_customer"))

        # Drop something that can wait.
        deferrable = [a for a in risk["stops_at_risk"] if a["priority"] == "standard"]
        options.append(_opt(
            "defer_low_priority", "Defer a non-SLA stop to tomorrow",
            f"Push {deferrable[-1]['job_code'] if deferrable else 'a stop'} to protect the SLA jobs",
            detail=("Takes the lowest-priority stop off today's round so the minutes go to the "
                    "appointments that carry a contractual deadline."),
            available=bool(deferrable) and risk["stops_remaining"] > 1,
            unavailable_reason=None if (deferrable and risk["stops_remaining"] > 1)
            else "Every remaining stop carries an SLA — none can be deferred.",
            eta_mins=-min(delay, 60), cost_gbp=0.0,
            sla_impact="SLA jobs protected; deferred job rebooked", confidence=86,
            recommended=bool(deferrable) and risk["sla_jobs_at_risk"] > 0,
            autonomy="human", threshold_key="eta_defer_stop",
            consequence="The deferred customer is rebooked — it counts as a missed first visit.",
            job_code=deferrable[-1]["job_code"] if deferrable else None))

        # Buy the time back with hours. Bounded by drivers' hours, which is why
        # it is never autonomous.
        van = self._van_for(risk["engineer_code"])
        hours_today = (van or {}).get("hours_driven_today", 0) or 0
        headroom = hours_today < 8.0
        options.append(_opt(
            "authorise_overtime", "Authorise overtime on this round",
            f"Extend the shift — {hours_today}h driven so far",
            detail=("Keeps every stop on today's round by extending the engineer's shift. Only "
                    "available while drivers' hours allow it, and it is paid time."),
            available=headroom,
            unavailable_reason=None if headroom else f"{hours_today}h already driven — extending would breach drivers' hours.",
            eta_mins=None, cost_gbp=round(max(1, delay / 60) * 42.0, 2),
            sla_impact="All stops retained", confidence=90,
            autonomy="human", threshold_key="eta_overtime",
            consequence="Paid overtime and a longer duty day for a named person."))

        # Escalate — the SLA-midpoint move when nothing else closes the gap.
        options.append(_opt(
            "escalate_sla", "Escalate to the duty manager",
            f"Raise an exception on {risk['sla_jobs_at_risk'] or risk['jobs_at_risk']} at-risk job(s)",
            detail=("Raises a tracked exception so the breach is owned, the clock is visible and "
                    "customer comms are coordinated rather than improvised at the door."),
            eta_mins=None, cost_gbp=0.0, sla_impact="Breach owned and tracked",
            confidence=93, recommended=risk["severity"] == "critical",
            autonomy="human", threshold_key="eta_escalate"))

        return _rank(options)

    def _nearest_capable_engineer(self, risk: dict) -> tuple[dict | None, float]:
        routes = self._snapshot.get("engineer_routes", {})
        worst = risk["stops_at_risk"][0] if risk["stops_at_risk"] else None
        if not worst:
            return None, 999.0
        best, best_miles = None, 999.0
        for eng in self._snapshot.get("engineer_locations", []):
            code = eng["engineer_code"]
            if code == risk["engineer_code"] or eng.get("job_status") == "off_duty":
                continue
            if eng.get("business_unit") != risk.get("business_unit"):
                continue
            if eng.get("van_stock_low"):
                continue
            r = routes.get(code) or {}
            if (r.get("delay_mins") or 0) >= 15:
                continue                      # already behind — do not compound it
            if (r.get("stops_total") or 0) - (r.get("stops_completed") or 0) >= 5:
                continue
            m = miles_between(worst.get("latitude"), worst.get("longitude"),
                              eng.get("latitude"), eng.get("longitude"))
            if m < best_miles:
                best, best_miles = eng, m
        return best, best_miles

    def resolve_eta_risk(self, engineer_code: str, action: str, by: str,
                         params: dict | None = None) -> dict:
        params = params or {}
        s = self._state()
        risk = next((r for r in s.get("route_eta_risk", []) if r["engineer_code"] == engineer_code), None)
        route = (s.get("engineer_routes") or {}).get(engineer_code)
        if not risk or not route:
            return {"error": "No open arrival risk for this engineer"}
        option = next((o for o in self.eta_risk_options(risk) if o["action"] == action), None)
        if not option:
            return {"error": f"Unknown action '{action}'"}
        if not option["available"]:
            return {"error": option["unavailable_reason"] or "Action not available in the current state"}

        before = risk["delay_mins"]
        summary, extra = option["label"], {}

        if action == "reroute":
            # Run the real optimiser over what is left, from where the van
            # actually is, in the traffic that is actually on the road — the same
            # engine the day was planned with. What it recovers is what it
            # recovers; nothing is credited that the sequence did not earn.
            plan = self.reoptimise_round(engineer_code, apply=True)
            if plan.get("error"):
                return {"error": plan["error"]}
            recover = max(0, plan.get("mins_saved") or 0)
            route["delay_mins"] = max(0, before - recover)
            extra = {"optimisation": plan}
            if recover:
                summary = (f"Round re-optimised — {recover} min and "
                           f"{plan['miles_saved']} mi out of the remaining round, "
                           f"delay {before} → {route['delay_mins']} min")
            else:
                # An honest null result. The sequence was already the best one
                # available, so the delay has to be recovered another way.
                summary = ("Re-optimised — the remaining stops are already in the best "
                           "order available, so no time could be recovered by re-sequencing")
        elif action == "reallocate_job":
            dst = (s.get("engineer_routes") or {}).get(option["cover_engineer_code"])
            job_code = params.get("job_code") or option["job_code"]
            moved = None
            for i, st in enumerate(route.get("stops", [])):
                if st.get("job_code") == job_code and st.get("status") != "completed":
                    moved = route["stops"].pop(i)
                    break
            self._resequence(route)
            if moved and dst is not None:
                dst.setdefault("stops", []).append({
                    **moved, "status": "pending",
                    "reallocated_from": engineer_code,
                    "reallocated_from_name": risk["engineer_name"],
                    "reallocated_at": _iso(_now()),
                    "planned_arrival": add_mins((dst["stops"] or [{}])[-1].get("planned_arrival", "16:00"), 45)})
                self._resequence(dst)
            route["delay_mins"] = max(0, before - 20)
            summary = f"{job_code} reallocated to {option['cover_engineer_name']} — appointment held"
            extra["job_code"] = job_code
        elif action == "notify_customer":
            route["customers_notified"] = risk["jobs_at_risk"]
            route["customers_notified_at"] = _iso(_now())
            self._post_outbound(
                "Salesforce Field Service · Customer Comms",
                "POST https://fs.centrica-svc.internal/api/v1/appointments/notify",
                {"engineer_code": engineer_code,
                 "jobs": [a["job_code"] for a in risk["stops_at_risk"]],
                 "revised_window_mins": before, "channel": ["sms", "app"], "by": by})
            summary = f"{risk['jobs_at_risk']} customer(s) sent a revised arrival window"
        elif action == "defer_low_priority":
            job_code = params.get("job_code") or option["job_code"]
            for st in route.get("stops", []):
                if st.get("job_code") == job_code:
                    st["status"] = "deferred"
                    st["deferred_to"] = (_now() + timedelta(days=1)).date().isoformat()
                    st["deferred_by"] = by
            route["stops"] = [st for st in route["stops"] if st.get("status") != "deferred"] + \
                             [st for st in route["stops"] if st.get("status") == "deferred"]
            route["delay_mins"] = max(0, before - min(before, 60))
            summary = f"{job_code} deferred to tomorrow — SLA jobs protected"
            extra["job_code"] = job_code
        elif action == "authorise_overtime":
            route["overtime_authorised_by"] = by
            route["overtime_mins"] = before
            summary = f"Overtime authorised — all {risk['stops_remaining']} remaining stop(s) retained"
        elif action == "escalate_sla":
            exc = self._raise_eta_exception(risk, by)
            summary = f"{exc['exception_code']} raised — {risk['jobs_at_risk']} job(s) at risk of breach"
            extra["exception_code"] = exc["exception_code"]

        route["eta_resolution"] = {"action": action, "label": option["label"], "by": by,
                                   "at": _iso(_now()), "summary": summary,
                                   "delay_before_mins": before,
                                   "delay_after_mins": route.get("delay_mins", 0),
                                   "cost_gbp": option["cost_gbp"], **extra}
        route["_road_cache"] = None
        # No hold: the round goes straight back to live traffic. The audit entry
        # below is the durable record of this decision, not the frozen number.
        self._res_log("arrival_risk", engineer_code, action, by, summary,
                      threshold_key=option["threshold_key"],
                      severity=risk["severity"], cost_gbp=option["cost_gbp"],
                      delay_before_mins=before, delay_after_mins=route.get("delay_mins", 0))
        self.refresh_route_eta_risk()
        self._sync_derived_state()
        return {"resolved": True, "engineer_code": engineer_code, **route["eta_resolution"]}

    def _raise_eta_exception(self, risk: dict, by: str) -> dict:
        self._exception_counter += 1
        exc = {
            "exception_code": f"EXC-{2026000 + self._exception_counter:04d}",
            "priority": "P2" if risk["sla_jobs_at_risk"] else "P3",
            "category": "arrival_risk",
            "title": f"Arrival risk — {risk['engineer_name']} ({risk['region']})",
            "description": (f"{risk['engineer_name']} is running {risk['delay_mins']} min behind "
                            f"({risk['cause_label'].lower()}). {risk['jobs_at_risk']} appointment(s) "
                            f"project past their window, worst by {risk['worst_breach_mins']} min."),
            "impacted_engineer_count": 1, "estimated_resolution_hours": 2,
            "impacted_skus": [],
            "recommended_action": ("Re-optimise the remaining round; reallocate the worst-breaching "
                                   "job to the nearest accredited engineer and send revised windows."),
            "automated_action_taken": None,
            "alert_channels_notified": {"in_app": True, "email": True, "sms": False, "slack": True},
            "recurrence_count": 1,
            "status": "open", "created_at": _iso(_now()), "updated_at": _iso(_now()),
            "raised_by": by}
        self._snapshot.setdefault("exceptions", []).insert(0, exc)
        return exc

    # ═════════════════════════════════════════════════════════════════════════
    # Route surgery — shared by several resolutions
    # ═════════════════════════════════════════════════════════════════════════

    @staticmethod
    def _resequence(route: dict) -> None:
        stops = route.get("stops", []) or []
        # A stop this engineer cannot legally work is not part of the drive
        # sequence, so it sorts to the end alongside anything deferred — same
        # treatment `defer_low_priority` already gives its own stops.
        stops = ([st for st in stops if st.get("status") != "blocked"]
                 + [st for st in stops if st.get("status") == "blocked"])
        route["stops"] = stops
        for i, st in enumerate(stops):
            st["seq"] = i + 1
        route["stops_total"] = len(stops)
        route["stops_completed"] = len([st for st in stops if st.get("status") == "completed"])
        route["stops_blocked"] = len([st for st in stops if st.get("status") == "blocked"])
        # Exactly one stop is "next": the first one still to be worked.
        seen_next = False
        for st in stops:
            if st.get("status") in TERMINAL_STOP_STATUSES:
                continue
            st["status"] = "next" if not seen_next else "pending"
            seen_next = True
        route["_road_cache"] = None

    def insert_collection_stop(self, engineer_code: str, *, point_kind: str, point_code: str,
                               point_name: str, detour_mins: int, sku_codes: list[str],
                               reason: str, by: str) -> dict:
        """Put a parts-collection stop into a van's route ahead of its next job.

        This is what makes "collect on the way" real: the stop appears on the
        Transport Control route map and timeline exactly like a job, every later
        arrival time moves back by the detour, and the road geometry is
        invalidated so the drawn route re-fetches through the collection point.
        """
        s = self._snapshot
        route = (s.get("engineer_routes") or {}).get(engineer_code)
        if not route:
            return {"error": "This engineer has no route today"}
        stops = route.get("stops", []) or []
        idx = next((i for i, st in enumerate(stops) if is_drivable(st)), len(stops))
        before_job = stops[idx].get("job_code") if idx < len(stops) else None

        if point_kind == "locker":
            src = next((l for l in s.get("locker_status", []) if l["bybox_site_code"] == point_code), None)
        else:
            src = next((h for h in self._hubs() if h["code"] == point_code), None)
        eng = self._engineer(engineer_code) or {}
        lat = (src or {}).get("latitude", eng.get("latitude"))
        lon = (src or {}).get("longitude", eng.get("longitude"))
        prev_time = stops[idx - 1].get("planned_arrival") if idx > 0 else "08:00"

        stop = {
            "seq": idx + 1,
            "job_code": f"COL-{uuid.uuid4().hex[:5].upper()}",
            "postcode": (src or {}).get("postcode") or eng.get("home_postcode"),
            "latitude": lat, "longitude": lon,
            "job_type": "parts_collection",
            "stop_kind": "collection",
            "collection_kind": point_kind,
            "collection_site": point_code,
            "collection_site_name": point_name,
            "sku_codes": sku_codes,
            "service_mins": 10,
            "priority": "standard",
            "planned_arrival": add_mins(prev_time, max(10, detour_mins - 10)),
            "sla_deadline": None,
            "status": "next",
            "added_by": by, "added_at": _iso(_now()), "added_reason": reason}
        stops.insert(idx, stop)
        # Everything behind the insertion moves back by the detour.
        for st in stops[idx + 1:]:
            if is_drivable(st):
                st["planned_arrival"] = add_mins(st.get("planned_arrival"), detour_mins)
                if st.get("sla_deadline"):
                    pass    # the customer's deadline does not move because we did
        route["stops"] = stops
        route["planned_miles"] = round((route.get("planned_miles") or 0) + detour_mins / 60 * 28, 1)
        route["planned_travel_mins"] = (route.get("planned_travel_mins") or 0) + detour_mins
        route["delay_mins"] = (route.get("delay_mins") or 0) + max(0, detour_mins - 10)
        route["delay_cause"] = "parts_collection"
        self._resequence(route)
        return {"stop": stop, "stops_total": route["stops_total"], "before_job_code": before_job}
