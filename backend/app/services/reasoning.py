"""
Decision tracing for the agentic layer.

Every action ATLAS proposes or executes carries a full, reconstructable record of
how it got there. Not a log line — a stack:

    SENSE        which live signals were read, from where, and what they said
    REASON       the ordered deterministic steps, each with the rule it applied,
                 the observation it matched and the confidence it moved
    NEGOTIATE    which specialist capabilities were consulted, what each argued,
                 and whether it supported, conditioned on something, or objected
    ARBITRATE    how the orchestrator resolved the disagreement
    POLICY       every governance gate evaluated, pass or fail, with the numbers
    DECIDE       the outcome, and why that outcome and not one of the alternatives

The negotiation is grounded, not decorative: each consulted capability reads the
same live snapshot the owning capability did and takes a position from it. A
supplier with a financial-health flag really does block a new commitment; severe
traffic really does turn a transport "support" into a condition. The argument the
operator reads in the trace is the argument that actually changed the outcome.

Nothing here calls an LLM. The trace is deterministic, so the same state always
produces the same reasoning — which is what makes it auditable.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "opportunity": 4}

# The capability roster as it speaks in a negotiation. Kept here (not imported)
# so a trace can be rendered even if the roster is filtered for a user.
VOICES = {
    "orchestrator":   {"name": "ATLAS", "role": "Master orchestration", "accent": "#8B5CF6"},
    "replenishment":  {"name": "Replenishment & Inventory", "role": "Service level & working capital", "accent": "#3B82F6"},
    "exception":      {"name": "Exception Response", "role": "SLA & incident playbooks", "accent": "#EF4444"},
    "supplier":       {"name": "Supplier Risk", "role": "OTIF, financial & ethical risk", "accent": "#0EA5E9"},
    "transport":      {"name": "Fleet & Compliance", "role": "Vehicles, walkarounds & CAZ", "accent": "#F59E0B"},
    "demand_sensing": {"name": "Demand Sensing", "role": "Weather & IoT-driven demand", "accent": "#10B981"},
    "visibility":     {"name": "Network Visibility", "role": "Lockers, inbound & throughput", "accent": "#6366F1"},
    "sustainability": {"name": "Sustainability", "role": "Reverse logistics & Scope 3", "accent": "#22C55E"},
    "custom":         {"name": "Watch Rules", "role": "Operator-authored thresholds", "accent": "#EC4899"},
}

STANCES = {
    "propose":     {"label": "Proposes",    "weight": 1.00, "color": "#3B82F6", "blocking": False},
    "support":     {"label": "Supports",    "weight": 1.00, "color": "#10B981", "blocking": False},
    "conditional": {"label": "Conditional", "weight": 0.55, "color": "#F59E0B", "blocking": False},
    "caution":     {"label": "Cautions",    "weight": 0.35, "color": "#F97316", "blocking": False},
    "object":      {"label": "Objects",     "weight": 0.00, "color": "#EF4444", "blocking": True},
    "abstain":     {"label": "Abstains",    "weight": 0.50, "color": "#64748B", "blocking": False},
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _tid(*parts) -> str:
    return "TRC-" + hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:8].upper()


def _voice(agent_id: str) -> dict:
    return VOICES.get(agent_id, {"name": agent_id, "role": "", "accent": "#64748B"})


# ═════════════════════════════════════════════════════════════════════════════
# CONTEXT — the shared facts every capability reads before taking a position
# ═════════════════════════════════════════════════════════════════════════════

def _reverse_backlog(state: dict) -> int:
    """`reverse_pipeline` is a staged funnel, not a list of units — anything
    still at the job or the trade counter has not been collected yet."""
    pipe = state.get("reverse_pipeline", {}) or {}
    if not isinstance(pipe, dict):
        return 0
    awaiting = {"Decommissioned at Job", "At Trade Counter"}
    return sum(st.get("count", 0) for st in pipe.get("stages", []) if st.get("stage") in awaiting)


def build_context(state: dict, *, value_gbp: int = 0, severity: str = "medium",
                  confidence: int = 75, supplier_code: str | None = None,
                  sku_code: str | None = None, extra: dict | None = None) -> dict:
    """Compress the live snapshot into the handful of facts a negotiation turns
    on. One pass, so tracing a queue of 20 recommendations stays cheap."""
    suppliers = state.get("supplier_scorecards", []) or []
    sup = next((s for s in suppliers if s.get("supplier_code") == supplier_code), None)
    fleet = state.get("fleet_vehicles", []) or []
    lockers = state.get("locker_status", []) or []
    whs = state.get("warehouse_status", []) or []
    exceptions = state.get("exceptions", []) or []
    open_exc = [e for e in exceptions if e.get("status") == "open"]
    inv = state.get("inventory_positions", []) or []
    item = next((i for i in inv if i.get("sku_code") == sku_code), None)
    weather = (state.get("demand_signals", {}) or {}).get("weather", {}) or {}
    ctx = {
        "value_gbp": value_gbp or 0,
        "severity": severity,
        "confidence": confidence,
        "supplier_code": supplier_code,
        "supplier_name": (sup or {}).get("name", supplier_code),
        "supplier_otif": (sup or {}).get("otif_score"),
        "supplier_financial_flag": bool((sup or {}).get("financial_health_flag")),
        "supplier_tier1": bool((sup or {}).get("is_tier1")),
        "sku_code": sku_code,
        "days_of_supply": (item or {}).get("days_of_supply"),
        "lead_time_days": (item or {}).get("lead_time_days"),
        "traffic": state.get("traffic_severity", "normal"),
        "vor_count": sum(1 for v in fleet if v.get("vor")),
        "fleet_size": len(fleet) or 1,
        "locker_alerts": sum(1 for l in lockers if l.get("status") == "alert"),
        "min_throughput": min([w.get("throughput_vs_baseline_pct", 100) for w in whs] or [100]),
        "open_exceptions": len(open_exc),
        "open_p1": sum(1 for e in open_exc if e.get("priority") == "P1"),
        "demand_uplift": weather.get("demand_uplift_factor", 1.0) or 1.0,
        "hdd": weather.get("heating_degree_days_7d", 0) or 0,
        "reverse_backlog": _reverse_backlog(state),
    }
    if extra:
        ctx.update(extra)
    return ctx


# ═════════════════════════════════════════════════════════════════════════════
# NEGOTIATION — each capability's grounded position
# ═════════════════════════════════════════════════════════════════════════════

def _pos(stance, argument, evidence=None):
    return {"stance": stance, "argument": argument, "evidence": evidence or []}


def _p_supplier(action_key: str, ctx: dict) -> dict:
    name = ctx.get("supplier_name") or "the routed supplier"
    otif = ctx.get("supplier_otif")
    if ctx.get("supplier_financial_flag"):
        return _pos("object",
                    f"{name} carries an open financial-health flag. Committing new spend to a "
                    f"counterparty in distress increases exposure with no recovery route if they fail.",
                    [{"label": "Financial health", "value": "FLAGGED"},
                     {"label": "Exposure added", "value": f"£{ctx['value_gbp']:,}"}])
    if otif is not None and otif < 65:
        return _pos("object",
                    f"{name} is delivering {otif:g}% OTIF. At that level the order is unlikely to land "
                    f"on the promised date, so it does not remove the cover risk it is meant to close.",
                    [{"label": "OTIF", "value": f"{otif:g}%"}, {"label": "Target", "value": "92%"}])
    if otif is not None and otif < 80:
        return _pos("conditional",
                    f"{name} is at {otif:g}% OTIF — below the 80% review trigger. I support the order "
                    f"only with the delivery tracked as at-risk and a dual-source note on the SKU.",
                    [{"label": "OTIF", "value": f"{otif:g}%"}, {"label": "Review trigger", "value": "80%"}])
    if otif is not None:
        return _pos("support",
                    f"{name} is at {otif:g}% OTIF against a 92% target — no commercial objection to "
                    f"placing this commitment.",
                    [{"label": "OTIF", "value": f"{otif:g}%"}])
    return _pos("abstain", "No supplier is named on this action — nothing for me to assess.")


def _p_transport(action_key: str, ctx: dict) -> dict:
    traffic, vor, size = ctx["traffic"], ctx["vor_count"], ctx["fleet_size"]
    vor_pct = round(vor / size * 100)
    if traffic in ("severe", "high"):
        return _pos("conditional",
                    f"Road conditions are {traffic}. Transit times are running long, so I support this "
                    f"only if the promised date carries the weather buffer rather than the planned lead.",
                    [{"label": "Traffic", "value": traffic}, {"label": "VOR", "value": f"{vor} ({vor_pct}%)"}])
    if vor_pct >= 12:
        return _pos("caution",
                    f"{vor} vehicles are off road ({vor_pct}% of the fleet). Delivery capacity for the "
                    f"onward leg is tight — the move works, but nothing else can slip this week.",
                    [{"label": "VOR", "value": f"{vor} of {size}"}])
    return _pos("support",
                f"Fleet has capacity — {vor} of {size} off road, traffic {traffic}. The onward leg fits "
                f"tonight's trunk run without adding a vehicle.",
                [{"label": "VOR", "value": f"{vor} of {size}"}, {"label": "Traffic", "value": traffic}])


def _p_replenishment(action_key: str, ctx: dict) -> dict:
    dos, lead = ctx.get("days_of_supply"), ctx.get("lead_time_days")
    if dos is not None and lead is not None and dos <= lead:
        return _pos("support",
                    f"Cover is {dos:g} days against a {lead}-day lead time — the position is already "
                    f"inside its own replenishment window. Acting now is cheaper than expediting later.",
                    [{"label": "Cover", "value": f"{dos:g}d"}, {"label": "Lead", "value": f"{lead}d"}])
    if dos is not None and dos > 120:
        return _pos("caution",
                    f"This SKU already holds {dos:g} days of cover. Adding to it ties up working capital "
                    f"that is better released elsewhere.",
                    [{"label": "Cover", "value": f"{dos:g}d"}])
    return _pos("support",
                "The position sits inside policy and the move protects first-time-fix without over-ordering.",
                [{"label": "Cover", "value": f"{dos:g}d" if dos is not None else "—"}])


def _p_demand_sensing(action_key: str, ctx: dict) -> dict:
    uplift, hdd = ctx["demand_uplift"], ctx["hdd"]
    if uplift >= 1.25:
        return _pos("support",
                    f"Demand is running ×{uplift:g} on {hdd:g} heating degree days. Whatever cover looks "
                    f"adequate on today's rate will not be adequate in seven days.",
                    [{"label": "Uplift", "value": f"×{uplift:g}"}, {"label": "HDD (7d)", "value": f"{hdd:g}"}])
    if uplift <= 0.95:
        return _pos("caution",
                    f"Demand is soft (×{uplift:g}). The urgency here is lower than the raw cover figure "
                    f"suggests — a standard lead time will do.",
                    [{"label": "Uplift", "value": f"×{uplift:g}"}])
    return _pos("support",
                f"Demand is stable at ×{uplift:g}; the forecast underpinning this is inside tolerance.",
                [{"label": "Uplift", "value": f"×{uplift:g}"}])


def _p_visibility(action_key: str, ctx: dict) -> dict:
    thr, alerts = ctx["min_throughput"], ctx["locker_alerts"]
    if thr < 60:
        return _pos("conditional",
                    f"The weakest hub is running at {thr:g}% of baseline throughput. Anything landing "
                    f"there will queue — I support this only if it routes to a healthy site.",
                    [{"label": "Lowest throughput", "value": f"{thr:g}%"}])
    if alerts >= 8:
        return _pos("caution",
                    f"{alerts} locker sites are alerting. Last-mile confirmation is degraded, so the "
                    f"benefit of this move lands later than the plan assumes.",
                    [{"label": "Locker alerts", "value": alerts}])
    return _pos("support",
                f"Network is clear — lowest hub at {thr:g}% of baseline, {alerts} locker alerts. "
                f"Nothing downstream blocks this.",
                [{"label": "Lowest throughput", "value": f"{thr:g}%"}, {"label": "Locker alerts", "value": alerts}])


def _p_sustainability(action_key: str, ctx: dict) -> dict:
    premium = any(k in action_key for k in ("emergency", "expedite", "pre_position"))
    if premium:
        est = max(12, round(ctx["value_gbp"] / 900)) if ctx["value_gbp"] else 45
        return _pos("caution",
                    f"Expedited freight adds roughly {est} kgCO₂e against a consolidated move and works "
                    f"against the Scope 3 trajectory. Not blocking — but consolidate if the date allows.",
                    [{"label": "Added Scope 3", "value": f"~{est} kgCO₂e"}])
    if "collection" in action_key or "returns" in action_key:
        return _pos("support",
                    f"Consolidating {ctx['reverse_backlog']} pending collections removes empty miles and "
                    f"protects the WEEE deadline at the same time.",
                    [{"label": "Backlog", "value": ctx["reverse_backlog"]}])
    return _pos("support", "No material Scope 3 or WEEE consequence in this action.")


def _p_exception(action_key: str, ctx: dict) -> dict:
    if ctx["open_p1"]:
        return _pos("conditional",
                    f"{ctx['open_p1']} P1 incident(s) are live. I support this provided it is sequenced "
                    f"behind the P1 response and does not consume the same capacity.",
                    [{"label": "Open P1", "value": ctx["open_p1"]},
                     {"label": "Open exceptions", "value": ctx["open_exceptions"]}])
    return _pos("support",
                f"{ctx['open_exceptions']} exceptions open, none P1. No incident conflict with this action.",
                [{"label": "Open exceptions", "value": ctx["open_exceptions"]}])


_POSITIONS = {
    "supplier": _p_supplier, "transport": _p_transport, "replenishment": _p_replenishment,
    "demand_sensing": _p_demand_sensing, "visibility": _p_visibility,
    "sustainability": _p_sustainability, "exception": _p_exception,
}


def negotiate(owner_id: str, consults, action_key: str, ctx: dict, *, proposal: str) -> list[dict]:
    """Run the round table. The owner tables the proposal; every consulted
    capability reads the same live facts and answers for its own domain."""
    table = [{
        "agent_id": owner_id, **_voice(owner_id), "stance": "propose",
        "stance_label": STANCES["propose"]["label"], "stance_color": STANCES["propose"]["color"],
        "weight": 1.0, "blocking": False, "argument": proposal,
        "evidence": [{"label": "Value at stake", "value": f"£{ctx['value_gbp']:,}" if ctx["value_gbp"] else "—"},
                     {"label": "Severity", "value": ctx["severity"]},
                     {"label": "Confidence", "value": f"{ctx['confidence']}%"}],
    }]
    for aid in consults:
        if aid == owner_id or aid == "orchestrator":
            continue
        fn = _POSITIONS.get(aid)
        if not fn:
            continue
        p = fn(action_key, ctx)
        meta = STANCES[p["stance"]]
        table.append({
            "agent_id": aid, **_voice(aid), "stance": p["stance"],
            "stance_label": meta["label"], "stance_color": meta["color"],
            "weight": meta["weight"], "blocking": meta["blocking"],
            "argument": p["argument"], "evidence": p["evidence"],
        })
    return table


def arbitrate(table: list[dict], ctx: dict) -> dict:
    """The orchestrator's job: turn a disagreement into one number and one rule.

    Consensus is the mean weight of every position other than the proposal — so a
    single blocking objection cannot be out-voted by three routine supports, and a
    room of conditionals lands in the middle rather than reading as agreement."""
    others = [p for p in table if p["stance"] != "propose"]
    blockers = [p for p in others if p["blocking"]]
    conditions = [p for p in others if p["stance"] == "conditional"]
    cautions = [p for p in others if p["stance"] == "caution"]
    score = round(sum(p["weight"] for p in others) / len(others) * 100) if others else 100
    if blockers:
        rule = "Any blocking objection from a domain owner overrides consensus."
        summary = (f"{blockers[0]['name']} objects: {blockers[0]['argument'].split('.')[0]}. "
                   f"I am not executing this on my own authority.")
        verdict = "blocked"
    elif conditions:
        rule = "Conditional support caps autonomy — the condition must be visible to whoever approves."
        n = len(conditions)
        summary = (f"{n} capabilit{'ies' if n != 1 else 'y'} support{'' if n != 1 else 's'} this only "
                   f"with a condition attached. The conditions are carried into the recommendation.")
        verdict = "conditional"
    elif cautions:
        rule = "Non-blocking cautions are recorded and the action proceeds."
        summary = (f"{len(cautions)} caution{'s' if len(cautions) != 1 else ''} noted and logged; none is "
                   f"blocking, so the action stands as proposed.")
        verdict = "clear"
    else:
        rule = "Unanimous support — the action proceeds on policy alone."
        summary = "Every consulted capability supports the action. Only the governance gates remain."
        verdict = "clear"
    return {
        "by": "ATLAS", "rule": rule, "summary": summary, "verdict": verdict,
        "consensus_score": score,
        "supporting": len([p for p in others if p["stance"] == "support"]),
        "conditional": len(conditions), "cautions": len(cautions), "objections": len(blockers),
        "conditions": [{"agent": p["name"], "condition": p["argument"]} for p in conditions],
        "dissent": [{"agent": p["name"], "objection": p["argument"]} for p in blockers],
    }


# ═════════════════════════════════════════════════════════════════════════════
# POLICY GATES
# ═════════════════════════════════════════════════════════════════════════════

def evaluate_policy(cfg: dict, ctx: dict, guardrails: dict, *, agent_autonomy: str = "auto",
                    ai_enabled: bool = True) -> dict:
    """Every gate the action must clear to self-execute, each with the number it
    was measured against. A failed gate is not an error — it is the reason the
    action is in front of a human."""
    gates = []

    def gate(name, requirement, actual, ok, detail=""):
        gates.append({"gate": name, "requirement": requirement, "actual": actual,
                      "pass": bool(ok), "detail": detail})

    gate("Master switch", "ATLAS enabled", "on" if ai_enabled else "off", ai_enabled,
         "The operator's kill switch. Off means propose-only, nothing self-executes.")
    gate("Capability autonomy", "auto", agent_autonomy, agent_autonomy == "auto",
         "The autonomy level set for the owning capability on the Capabilities tab.")

    klass = cfg.get("autonomy", "human")
    dual = cfg.get("dual_control", False)
    gate("Action class", "auto", "dual control" if dual else klass, klass == "auto" and not dual,
         cfg.get("why_human") or cfg.get("approval_trigger", ""))

    ceil = cfg.get("severity_ceiling", "medium")
    sev_ok = SEVERITY_RANK.get(ctx["severity"], 9) >= SEVERITY_RANK.get(ceil, 2)
    gate("Severity ceiling", f"≤ {ceil}", ctx["severity"], sev_ok,
         "Above the ceiling the stakes exceed what this action class may decide alone.")

    floor = cfg.get("confidence_floor", 70)
    gate("Confidence floor", f"≥ {floor}%", f"{ctx['confidence']}%", ctx["confidence"] >= floor,
         "Below the floor the evidence is too thin to act without a human read.")

    v = ctx.get("value_gbp", 0) or 0
    spend = bool(cfg.get("commits_spend"))
    caps = [cfg.get("value_ceiling_gbp", 0)]
    if spend:
        caps.append(guardrails.get("auto_approve_under_gbp", 0))
    caps = [x for x in caps if x > 0]
    cap = min(caps) if caps else 0
    if v > 0 and cap:
        gate("Value ceiling", f"≤ £{cap:,}", f"£{v:,}", v <= cap,
             ("The lower of the action's own ceiling and the global auto-approve guardrail."
              if spend else
              "This action's own ceiling. The global spend guardrail does not apply — it "
              "relocates stock the business already owns and commits no money."))
    dc = guardrails.get("requires_dual_control_over_gbp", 0)
    if v > 0 and dc and spend:
        gate("Dual-control line", f"< £{dc:,}", f"£{v:,}", v < dc,
             "At or above this value two named approvers are required for committed spend.")

    failed = [g for g in gates if not g["pass"]]
    return {
        "gates": gates, "failed": [g["gate"] for g in failed],
        "verdict": "auto" if not failed else "escalate",
        "class": "dual" if dual else klass,
        "blocking_gate": failed[0]["gate"] if failed else None,
    }


# ═════════════════════════════════════════════════════════════════════════════
# THE TRACE
# ═════════════════════════════════════════════════════════════════════════════

def build_trace(*, action_key: str, threshold_key: str, owner_agent: str, subject: str,
                cfg: dict, ctx: dict, guardrails: dict, signals: list[dict],
                reasoning: list[dict], proposal: str, alternatives: list[dict] | None = None,
                agent_autonomy: str = "auto", ai_enabled: bool = True,
                executed: bool = False, executed_by: str | None = None) -> dict:
    """Assemble the full stack for one decision."""
    consults = cfg.get("consults") or []
    table = negotiate(owner_agent, consults, action_key or threshold_key, ctx, proposal=proposal)
    arb = arbitrate(table, ctx)
    policy = evaluate_policy(cfg, ctx, guardrails, agent_autonomy=agent_autonomy, ai_enabled=ai_enabled)

    blocked = arb["verdict"] == "blocked"
    if blocked:
        outcome, rationale = "escalate_for_approval", (
            f"Blocked in negotiation — {arb['dissent'][0]['agent']} objected on domain grounds. "
            f"A human decides whether the objection is outweighed.")
    elif policy["verdict"] == "escalate":
        outcome = "escalate_for_approval"
        rationale = (f"Governance stopped it at the {policy['blocking_gate']} gate. "
                     + (cfg.get("why_human") or cfg.get("approval_trigger") or ""))
    else:
        outcome = "auto_executed" if executed else "auto_eligible"
        rationale = ("Every gate cleared and no capability objected — this is inside the mandate the "
                     "business has already granted, so it runs and is logged rather than queued.")

    # The call stack, rendered depth-first the way a stack trace reads.
    frames: list[dict] = []

    def frame(depth, fn, title, detail="", kind="step"):
        frames.append({"seq": len(frames) + 1, "depth": depth, "fn": fn,
                       "title": title, "detail": detail, "kind": kind})

    frame(0, "ATLAS.orchestrate()", f"Evaluate: {subject}",
          f"Action class '{threshold_key}' owned by {_voice(owner_agent)['name']}.", "root")
    frame(1, f"{owner_agent}.sense()", f"{len(signals)} live signal(s) read",
          "; ".join(f"{s['label']}={s['value']}" for s in signals[:4]) or "—", "sense")
    for i, r in enumerate(reasoning, 1):
        frame(2, f"{owner_agent}.reason(step={i})", r.get("inference", ""),
              f"rule: {r.get('rule', '')} · observed: {r.get('observation', '')}", "reason")
    for p in table:
        if p["stance"] == "propose":
            frame(2, f"{owner_agent}.propose()", "Proposal tabled to the round table", p["argument"], "propose")
        else:
            frame(3, f"{p['agent_id']}.consult()", f"{p['stance_label']} — {p['name']}",
                  p["argument"], "negotiate")
    frame(2, "ATLAS.arbitrate()", f"Consensus {arb['consensus_score']}% · {arb['verdict']}",
          arb["summary"], "arbitrate")
    for g in policy["gates"]:
        frame(3, f"policy.gate({g['gate'].lower().replace(' ', '_')})",
              f"{'PASS' if g['pass'] else 'FAIL'} — required {g['requirement']}, actual {g['actual']}",
              g["detail"], "policy")
    frame(1, "ATLAS.decide()", outcome.replace("_", " "), rationale, "decide")

    return {
        "trace_id": _tid(threshold_key, subject, ctx.get("severity"), ctx.get("confidence")),
        "created_at": _now(),
        "action_key": action_key, "threshold_key": threshold_key,
        "subject": subject,
        "owner_agent": {"id": owner_agent, **_voice(owner_agent)},
        "deliberation_ms": 40 + len(table) * 35 + len(reasoning) * 18,
        "signals": signals,
        "reasoning": reasoning,
        "negotiation": table,
        "arbitration": arb,
        "policy": policy,
        "alternatives": alternatives or [],
        "decision": {
            "outcome": outcome,
            "confidence": ctx["confidence"],
            "consensus": arb["consensus_score"],
            "rationale": rationale,
            "executed": executed,
            "executed_by": executed_by,
            "requires_dual_control": policy["class"] == "dual",
            "conditions": [c["condition"] for c in arb["conditions"]],
        },
        "frames": frames,
    }
