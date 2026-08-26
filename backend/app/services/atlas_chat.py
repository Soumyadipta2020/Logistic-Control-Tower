"""
Ask ATLAS — the conversational surface over the entire control tower.

The other tabs of the AI panel are shaped like the work: a queue to triage, a log
to audit, a policy table to read. This one is shaped like a colleague. So it gets
the two things a colleague has and a form does not:

  1. THE WHOLE PICTURE.  Every request is answered against a digest of the live
     snapshot — every KPI family, every open exception, inventory, suppliers,
     fleet, lockers, carriers, the approval queue and the governance posture — and
     ATLAS can drill further into ANY section of raw state with `query_state`.
     Nothing is answered from memory or from a summary written days ago.

  2. HANDS.  It can actually do the thing it just recommended. Every action it
     can take is bound to a row in the SAME action catalogue that governs the
     approvals queue (`app.synthetic.actions`), so the identical policy decides
     what happens next:

        · the action's class is `auto` and its gates pass  → ATLAS executes it
          immediately, inside the conversation, and reports what it did
        · anything else (human class, dual control, over a value ceiling, master
          switch off, or the operator lacks the permission)  → ATLAS prepares the
          action and hands back a PROPOSAL the human approves in the chat

     There is no second policy engine and no chat-only back door: an action ATLAS
     cannot self-execute from the queue, it cannot self-execute from here either,
     and every execution lands in the same audit log with the same trace.

Everything degrades safely. With no Gemini key the tab still answers from the
deterministic reasoning the engine has always used — it simply cannot converse.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timezone

from app.auth.rbac import satisfies
from app.services import chat_history, llm
from app.services.agent_engine import agent_engine, AGENTS_BY_ID, ORCH
from app.synthetic.actions import ACTION_CATALOG, catalog_summary
from app.synthetic.state import synthetic_state, ACTION_THRESHOLDS

logger = logging.getLogger("clt.atlas.chat")

# How many times ATLAS may read state / act before it must produce an answer.
# Four is enough for "look it up → check a second thing → act → summarise" and
# short enough that a confused model cannot spin.
MAX_TOOL_ROUNDS = 4
MAX_HISTORY_TURNS = 12


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pid(*parts) -> str:
    return "prop-" + hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:10]


_PSEUDO_TAG = re.compile(
    r"<\s*/?\s*(?:approval|action|proposal|approval-card|action-card|card|button|widget)[\w-]*"
    r"(?:\s[^>]*)?/?>", re.IGNORECASE)
_ANY_TAG = re.compile(r"</?[a-zA-Z][\w-]*(?:\s[^<>]*)?/?>")
_TRAILING_RULE = re.compile(r"\n\s*(?:-{3,}|\*{3,}|_{3,})\s*$")
_CODE_REGION = re.compile(r"(```.*?```|`[^`\n]*`)", re.DOTALL)


def _strip_pseudo_markup(text: str) -> str:
    """Remove markup the model invents to mark where the UI should put things.

    Told that an approval card is rendered beneath its reply, the model helpfully
    writes `<approval-card recommendation_id="…" />` where it imagines the card
    goes — a templating convention it made up, for a renderer that has none. The
    cards themselves are real and correct; the tags are just leaked scaffolding,
    and they read like a bug to whoever is looking at the answer.

    The prompt asks it not to, but a prompt is a probability and this is a
    certainty: the answer surface renders no raw HTML at all, so any tag in it is
    noise by definition and is removed here.
    """
    if not text or "<" not in text:
        return text
    # Code is quoted content, not markup: `<threshold>` in a code span is
    # something the operator asked about and must survive intact. Splitting on a
    # capturing group interleaves [prose, code, prose, …], so only the even
    # positions are rewritten.
    parts = _CODE_REGION.split(text)
    for i in range(0, len(parts), 2):
        parts[i] = _ANY_TAG.sub("", _PSEUDO_TAG.sub("", parts[i]))
    cleaned = "".join(parts)
    # Stripping a trailing block can leave the separator that introduced it.
    cleaned = _TRAILING_RULE.sub("", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


# Prose that tells the operator a card is waiting under the answer. Told that a
# card renders beneath its reply, a model will sometimes write the sentence and
# skip the call — "I have staged the first transfer for your approval below",
# with nothing below it. The sentence is the only evidence the operator has, so
# an unbacked one reads as a broken page and quietly costs them the decision it
# said they could take from here.
# Three signals, because any two of them occur innocently. "5 transfers are
# QUEUED FOR APPROVAL" is a description of the queue; "stock was PREPARED at the
# NDC and shipped BELOW the reorder point" is a fact about inventory. Only a
# sentence carrying all three — something was staged, it is HERE, and it is a
# decision to take — is claiming a card that must therefore exist.
_STAGE_VERB = re.compile(
    r"\b(?:staged?|staging|prepared?|preparing|queued|lined up|readied|teed up|"
    r"put (?:it|this|that|them|the\b))\b", re.IGNORECASE)
_CARD_LOCATOR = re.compile(
    r"\b(?:below|beneath|approval card|in this (?:chat|conversation|thread)|right here)\b",
    re.IGNORECASE)
_APPROVAL_OBJECT = re.compile(
    r"\b(?:approv\w+|decision|card|sign[- ]?off|authoris\w+|authoriz\w+)\b", re.IGNORECASE)
_SENTENCE = re.compile(r"(?<=[.!?])\s+")


def _promises_card(text: str) -> bool:
    """Does this text claim an approval card was prepared for the operator?

    All three signals must land in the SAME sentence — a promise is one clause,
    whereas the innocent collisions are two unrelated facts sharing a paragraph.
    """
    for sentence in _SENTENCE.split((text or "").replace("\n", " ")):
        if (_STAGE_VERB.search(sentence) and _CARD_LOCATOR.search(sentence)
                and _APPROVAL_OBJECT.search(sentence)):
            return True
    return False


def _drop_card_promise(text: str) -> str:
    """Remove a promise of a card that could not be prepared.

    Reached only once staging has genuinely failed. Everything else in the reply
    is grounded and stays; what goes is the one sentence that would send the
    operator looking beneath the answer for a button that is not there.
    """
    lines: list[str] = []
    for line in (text or "").split("\n"):
        if not line.strip():
            lines.append(line)
            continue
        kept = [s for s in _SENTENCE.split(line.strip()) if not _promises_card(s)]
        if kept:   # a bullet emptied of its only sentence goes with the sentence
            lines.append(line[:len(line) - len(line.lstrip())] + " ".join(kept))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _num(v, default=0):
    try:
        return type(default)(v)
    except (TypeError, ValueError):
        return default


# ═════════════════════════════════════════════════════════════════════════════
# TOOLS — what ATLAS may do inside a conversation
# ═════════════════════════════════════════════════════════════════════════════
# Read tools run immediately and silently. Write tools are all bound to a
# `threshold_key` from the action catalogue, which is what decides whether they
# self-execute or come back as a proposal — see `_govern()`.

_STATE_SECTIONS = {
    "inventory_positions", "supplier_scorecards", "exceptions", "warehouse_status",
    "fleet_vehicles", "engineer_locations", "locker_status", "purchase_orders",
    "transfer_orders", "shipments", "carrier_movements", "van_stock_alerts",
    "locker_misses", "route_eta_risk", "boiler_fault_pipeline", "predictive_replacements",
    "labour_assessments", "van_telematics", "hts_batches", "alert_rules",
    "executive_kpis", "operational_kpis", "transport_kpis", "procurement_kpis",
    "sustainability_kpis", "field_dispatcher_kpis", "demand_signals", "kpis",
    "heat_pump_pipeline", "smart_meter_dashboard", "reverse_pipeline",
    "sustainability_dashboard", "scope3_emissions", "circular_economy_kpis",
    "smart_meter_status", "exceptions_summary", "resolution_log",
}

TOOLS: list[dict] = [
    {
        "name": "query_state",
        "description": (
            "Read raw live state from any section of the control tower snapshot when the "
            "summary you were given is not specific enough — e.g. a named SKU, a named "
            "supplier, one engineer, one warehouse, one PO. Returns matching records."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "section": {"type": "STRING", "description": "Section to read: " + ", ".join(sorted(_STATE_SECTIONS))},
                "search": {"type": "STRING", "description": "Optional case-insensitive text to match anywhere in the record (SKU code, name, postcode, status…)."},
                "limit": {"type": "INTEGER", "description": "Max records to return (default 8, max 25)."},
            },
            "required": ["section"],
        },
    },
    {
        "name": "list_approvals",
        "description": (
            "List the decisions currently escalated to the human in the approvals queue, "
            "with their recommendation ids, severity, value and why each needs a human. "
            "Call this before approving or dismissing anything."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "severity": {"type": "STRING", "description": "Optional filter: critical, high, medium, low, opportunity."},
            },
        },
    },
    {
        "name": "list_resolution_options",
        "description": (
            "List the courses of action available for one open alert, priced against live state — "
            "cost, time effect, SLA impact, which one is recommended, and the exact action key to "
            "pass to apply_resolution. Call this before apply_resolution unless you already know "
            "the key."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "kind": {"type": "STRING", "description": "van | locker | carrier | eta"},
                "subject": {"type": "STRING", "description": "engineer_code (van, eta), site_code (locker) or movement_ref (carrier)"},
            },
            "required": ["kind", "subject"],
        },
    },
    {
        "name": "explain_policy",
        "description": (
            "Look up the governance policy for an action: which autonomy class it is in, "
            "the gates it must pass to self-execute, and why a human decides it."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "search": {"type": "STRING", "description": "Action name or keyword, e.g. 'emergency purchase order', 'dual source', 'activate plan'."},
            },
            "required": ["search"],
        },
    },
    {
        "name": "approve_recommendation",
        "description": (
            "Approve a decision from the approvals queue by its recommendation id. This "
            "executes the real underlying action (raises the PO, applies the resolution, "
            "activates the plan…)."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "recommendation_id": {"type": "STRING"},
                "rationale": {"type": "STRING", "description": "One line: why this should be approved."},
            },
            "required": ["recommendation_id"],
        },
    },
    {
        "name": "stage_for_approval",
        "description": (
            "Put a queued decision in front of the operator as an approval card in this "
            "conversation, WITHOUT executing it. Use this whenever you recommend a queued "
            "decision — when asked what needs approving, which to approve first, or what you "
            "would do — so they can act on your recommendation without leaving the chat. "
            "Stage only the one or two you actually recommend."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "recommendation_id": {"type": "STRING"},
                "rationale": {"type": "STRING", "description": "One line: why this one, and why first."},
            },
            "required": ["recommendation_id"],
        },
    },
    {
        "name": "dismiss_recommendation",
        "description": "Dismiss a queued decision with a reason. The reason is logged against the audit trail.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "recommendation_id": {"type": "STRING"},
                "reason": {"type": "STRING"},
            },
            "required": ["recommendation_id", "reason"],
        },
    },
    {
        "name": "apply_resolution",
        "description": (
            "Apply an operational fix to an open alert: a van stock shortfall (kind='van', "
            "subject=engineer_code), a locker pre-8AM miss (kind='locker', subject=site_code), "
            "a late carrier leg (kind='carrier', subject=movement_ref) or an at-risk round "
            "(kind='eta', subject=engineer_code). Get the subject id from the live summary or "
            "query_state, and the action key from list_resolution_options."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "kind": {"type": "STRING", "description": "van | locker | carrier | eta"},
                "subject": {"type": "STRING", "description": "engineer_code, site_code or movement_ref"},
                "action": {"type": "STRING", "description": "The option's action key from list_resolution_options, e.g. inter_van_transfer, escalate_carrier, reroute."},
            },
            "required": ["kind", "subject", "action"],
        },
    },
    {
        "name": "raise_purchase_order",
        "description": "Raise a replenishment purchase order for a SKU. Use po_type='emergency' only when cover is already breached.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "sku_code": {"type": "STRING"},
                "quantity": {"type": "INTEGER"},
                "po_type": {"type": "STRING", "description": "standard | emergency (default standard)"},
                "supplier_code": {"type": "STRING", "description": "Optional — defaults to the SKU's primary supplier."},
                "warehouse_code": {"type": "STRING", "description": "Optional — defaults to the Leicester NDC."},
                "reason": {"type": "STRING"},
            },
            "required": ["sku_code", "quantity"],
        },
    },
    {
        "name": "raise_transfer",
        "description": "Raise a stock transfer order (STO) moving stock the business already owns between sites.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "sku_code": {"type": "STRING"},
                "to_warehouse": {"type": "STRING", "description": "Receiving site code, e.g. COV_HUB."},
                "quantity": {"type": "INTEGER"},
                "from_warehouse": {"type": "STRING", "description": "Optional supplying site — defaults to the NDC."},
                "reason": {"type": "STRING"},
            },
            "required": ["sku_code", "to_warehouse", "quantity"],
        },
    },
    {
        "name": "expedite_purchase_order",
        "description": "Expedite an in-flight purchase order, pulling its delivery forward for a premium.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "po_number": {"type": "STRING"},
                "reason": {"type": "STRING"},
            },
            "required": ["po_number"],
        },
    },
    {
        "name": "acknowledge_exception",
        "description": "Acknowledge and take ownership of an open exception by its code (e.g. EXC-2026-0001).",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "exception_code": {"type": "STRING"},
                "notes": {"type": "STRING"},
            },
            "required": ["exception_code"],
        },
    },
    {
        "name": "activate_risk_plan",
        "description": "Activate the researched response plan attached to an exception. Commits the network to that playbook.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "exception_code": {"type": "STRING"},
                "rationale": {"type": "STRING"},
            },
            "required": ["exception_code"],
        },
    },
    {
        "name": "resolve_exception",
        "description": "Close an exception with a root cause. Only when the underlying issue is genuinely resolved.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "exception_code": {"type": "STRING"},
                "root_cause": {"type": "STRING"},
                "notes": {"type": "STRING"},
            },
            "required": ["exception_code", "root_cause"],
        },
    },
    {
        "name": "set_capability_autonomy",
        "description": "Change how much a capability may do on its own: manual, semi or auto.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "capability_id": {"type": "STRING", "description": "e.g. replenishment, transport, visibility, exception, supplier, demand_sensing, sustainability"},
                "level": {"type": "STRING", "description": "manual | semi | auto"},
            },
            "required": ["capability_id", "level"],
        },
    },
    {
        "name": "set_ai_mode",
        "description": "Turn the whole autonomous layer on or off. With it off, nothing self-executes and every proposal waits for a human.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "enabled": {"type": "BOOLEAN"},
                "rationale": {"type": "STRING"},
            },
            "required": ["enabled"],
        },
    },
]

READ_TOOLS = {"query_state", "list_approvals", "explain_policy", "list_resolution_options"}

# Where each resolution family keeps its open alerts, and how one is identified.
# The option engine names an action one way (`reroute`) and the governance
# catalogue names the same action another (`eta_reroute`); both are legitimate
# handles on it, so `_resolution_options` below accepts either.
_ALERT_SOURCE = {
    "van":     ("van_stock_alerts", "engineer_code", "van_alert_options"),
    "locker":  ("locker_misses", "site_code", "locker_miss_options"),
    "carrier": ("carrier_movements", "movement_ref", "carrier_options"),
    "eta":     ("route_eta_risk", "engineer_code", "eta_risk_options"),
}


def _resolution_options(kind: str, subject: str) -> list[dict]:
    """The priced courses of action open on one alert, or [] if there is no such alert."""
    src = _ALERT_SOURCE.get(kind)
    if not src:
        return []
    section, id_field, options_fn = src
    row = next((r for r in synthetic_state.get_snapshot().get(section, []) or []
                if str(r.get(id_field)) == str(subject)), None)
    if row is None:
        return []
    try:
        return getattr(synthetic_state, options_fn)(row) or []
    except Exception:
        return []


def _match_option(options: list[dict], action: str) -> dict | None:
    """Find the option `action` refers to, however it was named.

    The model may hand back the option key, the governance threshold key, or the
    threshold key with its family prefix still attached. All three identify the
    same action, and refusing two of them would be pedantry that costs the
    operator a working instruction.
    """
    want = (action or "").strip().lower()
    if not want:
        return None
    for opt in options:
        if want in {str(opt.get("action", "")).lower(), str(opt.get("threshold_key", "")).lower()}:
            return opt
    for opt in options:
        tk = str(opt.get("threshold_key", "")).lower()
        if tk.endswith(want) or want.endswith(str(opt.get("action", "")).lower()):
            return opt
    return None

def _resolve_staged_rec(rec_id: str) -> dict | None:
    """The queued decision `rec_id` refers to, forgiving an id that was rebuilt
    rather than copied.

    Recommendation ids are hashes. A model that has read the queue will still
    sometimes hand back `rec-van-priya-jones` — what the row looked like to it
    rather than what it was called — and an exact-match miss turns a recommended
    decision into no card at all, which is the failure this whole path exists to
    prevent. The id is only a handle.

    Deliberately used for STAGING alone. Staging executes nothing: the card names
    the decision in full and the human still decides, so a wrong match is visible
    and costs a decline. `approve_recommendation` runs the action for real and
    stays on exact ids, where a near miss would execute the wrong thing.
    """
    rec_id = (rec_id or "").strip()
    if not rec_id:
        return None
    rec = agent_engine._find(rec_id)
    if rec:
        return rec

    pending = agent_engine._pending_recommendations()
    low = rec_id.lower()
    for r in pending:
        rid = r["id"].lower()
        if rid == low or (len(low) >= 6 and (rid.startswith(low) or low.startswith(rid) or low in rid)):
            return r

    # Nothing id-shaped matched, so read the id as words and score them against
    # the decision they describe — the form an invented id almost always takes.
    words = [w for w in re.split(r"[^a-z0-9]+", low) if len(w) > 2 and w not in ("rec", "prop", "approval")]
    if not words:
        return None
    best, score = None, 0
    for r in pending:
        hay = f"{r['id']} {r.get('title', '')} {r.get('summary', '')} {r.get('module_label', '')}".lower()
        hits = sum(1 for w in words if w in hay)
        if hits > score:
            best, score = r, hits
    return best if score >= max(2, (len(words) + 1) // 2) else None


# Write tool → the catalogue row that governs it. This is the whole binding: the
# chat has no autonomy policy of its own, it borrows the queue's.
_TOOL_THRESHOLD = {
    "approve_recommendation": None,            # governed by the recommendation's OWN action
    "stage_for_approval": None,                # never executes — always becomes a card
    "dismiss_recommendation": "dismiss_recommendation",
    "apply_resolution": None,                  # governed by the resolution option's action
    "raise_purchase_order": "raise_po_standard",
    "raise_transfer": "raise_transfer",
    "expedite_purchase_order": "expedite_po",
    "acknowledge_exception": "acknowledge",
    "activate_risk_plan": "activate_plan",
    "resolve_exception": "resolve_exception",
    "set_capability_autonomy": "set_agent_autonomy",
    "set_ai_mode": "toggle_ai_mode",
}


class AtlasChat:
    """The conversation belongs to the client and to `chat_history`; what lives
    here is the ledger of actions ATLAS has prepared but not taken — an approval
    a human has not yet given cannot be held in the browser, where it could be
    edited into something else before it came back."""

    def __init__(self) -> None:
        # Process-local mirror. The durable copy is in `chat_history`, so a
        # restart or a deploy does not void every card an operator was about to
        # press; this dict only saves a round trip within one process.
        self._proposals: dict[str, dict] = {}

    async def _remember(self, prop: dict) -> None:
        self._proposals[prop["id"]] = prop
        await chat_history.save_proposal(prop)

    async def _recall(self, pid: str) -> dict | None:
        prop = self._proposals.get(pid)
        if prop is None:
            prop = await chat_history.get_proposal(pid)
            if prop is not None:
                self._proposals[pid] = prop
        return prop

    # ── the live picture ────────────────────────────────────────────────────
    def state_digest(self) -> dict:
        """Everything ATLAS knows right now, summarised domain by domain.

        Deliberately a digest and not the raw snapshot: 1,200 inventory rows and
        200 engineers would be mostly noise and would crowd out the reasoning.
        What matters is that NOTHING is omitted at the domain level — every
        module is represented — and that anything summarised here can be read in
        full with `query_state`.
        """
        s = synthetic_state.get_snapshot()
        recs = agent_engine._pending_recommendations()
        metrics = agent_engine.metrics(recs)
        health = synthetic_state.health_state()

        inv = s.get("inventory_positions", []) or []
        reds = [i for i in inv if i.get("rag_status") == "R"]
        ambers = [i for i in inv if i.get("rag_status") == "A"]
        worst_cover = sorted(
            (i for i in inv if (i.get("days_of_supply") or 999) < 900),
            key=lambda i: i.get("days_of_supply", 999))[:12]

        scs = s.get("supplier_scorecards", []) or []
        vehicles = s.get("fleet_vehicles", []) or []
        engineers = s.get("engineer_locations", []) or []
        lockers = s.get("locker_status", []) or []
        pos = s.get("purchase_orders", []) or []
        stos = s.get("transfer_orders", []) or []
        opens = [e for e in s.get("exceptions", []) or [] if e.get("status") == "open"]

        late_legs = sorted(
            [m for m in s.get("carrier_movements", []) or []
             if (m.get("delay_mins") or 0) > 0 and m.get("status") != "delivered" and not m.get("resolution")],
            key=lambda m: -(m.get("delay_mins") or 0))[:8]
        van_alerts = [a for a in s.get("van_stock_alerts", []) or [] if a.get("status") == "open"]
        misses = [m for m in s.get("locker_misses", []) or [] if m.get("status") == "open"]
        eta_risk = [r for r in s.get("route_eta_risk", []) or [] if r.get("status") == "open"]

        sig = s.get("demand_signals", {}) or {}
        w = sig.get("weather", {}) or {}
        hive = sig.get("hive_faults", {}) or {}
        iot_estate = synthetic_state.get_iot_estate_health()

        def kpi_block(key):
            return {k: {"value": v.get("value"), "target": v.get("target"), "rag": v.get("rag")}
                    for k, v in (s.get(key, {}) or {}).items() if isinstance(v, dict)}

        auto_24h = [e for e in agent_engine.activity(60) if e.get("kind") in ("auto", "approved")][:10]

        return {
            "as_of": s.get("last_refresh"),
            "network_health": health,
            "ai_mode_on": synthetic_state.ai_mode,
            "fleet_autonomy": agent_engine._fleet_autonomy,
            "capability_autonomy": {a: lvl for a, lvl in agent_engine._autonomy.items()},
            "guardrails_gbp": agent_engine._guardrails,
            "governance_posture": catalog_summary(),
            "metrics": metrics,
            "approvals_queue": [{
                "recommendation_id": r["id"], "title": r["title"], "severity": r["severity"],
                "area": r.get("module_label"), "value_gbp": r.get("value_gbp"),
                "confidence": r.get("confidence"), "consensus": r.get("consensus"),
                "class": r.get("policy_autonomy"), "waiting_since": r.get("created_at"),
                "why_human": (r.get("governance") or {}).get("why_human")
                             or (r.get("governance") or {}).get("approval_trigger"),
                "action": (r.get("action") or {}).get("label"),
                "items": (r.get("batch") or {}).get("count", 1),
            } for r in recs[:20]],
            "exceptions_open": [{
                "code": e.get("exception_code"), "priority": e.get("priority"), "title": e.get("title"),
                "category": e.get("category"), "engineers_impacted": e.get("impacted_engineer_count"),
                "eta_hours": e.get("estimated_resolution_hours"), "plan_activated": e.get("plan_activated", False),
                "recommended_action": e.get("recommended_action"),
            } for e in opens],
            "executive_kpis": kpi_block("executive_kpis"),
            "operational_kpis": kpi_block("operational_kpis"),
            "transport_kpis": kpi_block("transport_kpis"),
            "procurement_kpis": kpi_block("procurement_kpis"),
            "sustainability_kpis": kpi_block("sustainability_kpis"),
            "inventory": {
                "skus_tracked": len(inv), "red": len(reds), "amber": len(ambers),
                "stockouts": sum(1 for i in inv if (i.get("quantity_available") or 0) <= 0),
                "excess_value_gbp": round(sum(i.get("excess_value_gbp") or 0 for i in inv)),
                "stock_value_gbp": round(sum(i.get("stock_value_gbp") or 0 for i in inv)),
                "lowest_cover": [{
                    "sku": i["sku_code"], "description": i.get("description"),
                    "days_of_supply": i.get("days_of_supply"), "available": i.get("quantity_available"),
                    "reorder_point": i.get("reorder_point"), "order_qty": i.get("target_order_qty"),
                    "supplier": i.get("primary_supplier"), "rag": i.get("rag_status"),
                    "segment": i.get("segment"),
                } for i in worst_cover],
            },
            "suppliers": [{
                "code": x.get("supplier_code"), "name": x.get("name"), "category": x.get("category"),
                "otif": x.get("otif_score"), "risk": x.get("composite_risk_score"),
                "financial_flag": x.get("financial_health_flag"),
                "geopolitical_flag": x.get("geopolitical_risk_flag"),
                "sedex": x.get("sedex_risk_level"),
            } for x in sorted(scs, key=lambda x: x.get("otif_score") or 100)],
            "warehouses": [{
                "code": x.get("code"), "name": x.get("name"), "throughput_pct": x.get("throughput_vs_baseline_pct"),
                "items_per_hour": x.get("items_per_hour"), "staff": x.get("staff_present"),
                "labour_risk": x.get("labour_risk_score"), "disrupted": x.get("is_disrupted"),
            } for x in s.get("warehouse_status", []) or []],
            "field": {
                "engineers_active": len(engineers),
                "engineers_low_van_stock": sum(1 for e in engineers if e.get("van_stock_low")),
                "vehicles": len(vehicles),
                "vehicles_off_road": [{"reg": v["registration"], "engineer": v.get("engineer_name"),
                                       "defects": len(v.get("defects") or [])}
                                      for v in vehicles if v.get("vor")][:10],
                "walkarounds_outstanding": sum(1 for v in vehicles if not v.get("walkaround_completed")),
                "non_caz_compliant": sum(1 for v in vehicles if not v.get("caz_compliant")),
                "lockers_total": len(lockers),
                "lockers_offline": sum(1 for l in lockers if l.get("status") != "healthy"),
            },
            "open_alerts": {
                "van_stock": [{"engineer": a["engineer_code"], "name": a.get("engineer_name"),
                               "severity": a.get("severity"), "units_short": a.get("shortfall_units"),
                               "jobs_at_risk": a.get("jobs_at_risk")} for a in van_alerts[:8]],
                "van_stock_total": len(van_alerts),
                "locker_misses": [{"site": m["site_code"], "reason": m.get("reason_label"),
                                   "severity": m.get("severity"), "jobs_at_risk": m.get("jobs_at_risk")}
                                  for m in misses[:8]],
                "locker_misses_total": len(misses),
                "carrier_delays": [{"ref": m["movement_ref"], "carrier": m.get("carrier"),
                                    "dest": m.get("dest_name"), "delay_mins": m.get("delay_mins"),
                                    "sla_at_risk": m.get("sla_at_risk")} for m in late_legs],
                "eta_risk": [{"engineer": r["engineer_code"], "name": r.get("engineer_name"),
                              "delay_mins": r.get("delay_mins"), "cause": r.get("cause_label"),
                              "jobs_at_risk": r.get("jobs_at_risk")} for r in eta_risk[:8]],
                "eta_risk_total": len(eta_risk),
            },
            "orders": {
                "purchase_orders_open": sum(1 for p in pos if p.get("status") in ("draft", "confirmed", "in_transit")),
                "po_value_open_gbp": round(sum(p.get("total_value_gbp") or 0 for p in pos
                                               if p.get("status") in ("draft", "confirmed", "in_transit"))),
                "emergency_pos": sum(1 for p in pos if p.get("po_type") == "emergency"),
                "transfers_open": sum(1 for t in stos if t.get("status") in ("draft", "requested", "approved", "in_transit")),
                "recent_pos": [{"po": p["po_number"], "sku": p.get("sku_code"), "supplier": p.get("supplier_name"),
                                "type": p.get("po_type"), "status": p.get("status"),
                                "value_gbp": p.get("total_value_gbp")} for p in pos[:8]],
            },
            "demand_signals": {
                "heating_degree_days_7d": w.get("heating_degree_days_7d"),
                "demand_uplift_factor": w.get("demand_uplift_factor"),
                "temperature_c": w.get("temperature_c"),
                "hive_high_probability_24h": hive.get("high_probability_signals_24h"),
                "boiler_faults_tracked": len(s.get("boiler_fault_pipeline", []) or []),
                "predictive_replacements": len(s.get("predictive_replacements", []) or []),
                # Predicted faults are only worth raising if we can stock them, so
                # the digest carries the cover rate alongside the signal count —
                # otherwise ATLAS can report a surge it has no way to qualify.
                "iot_parts_cover_pct": iot_estate.get("parts_cover_pct"),
                "iot_pre_positioning_blocked": iot_estate.get("pre_positioning_blocked"),
            },
            "recently_actioned": [{"when": e.get("ts"), "what": e.get("title"),
                                   "how": e.get("kind"), "by": e.get("by")} for e in auto_24h],
        }

    def _context_text(self, digest: dict) -> str:
        return json.dumps(digest, default=str, separators=(",", ":"))

    # ── governance ──────────────────────────────────────────────────────────
    @staticmethod
    def _govern(threshold_key: str | None, *, severity="medium", confidence=88,
                value_gbp=0, user_perms: set | None = None) -> dict:
        """May ATLAS do this on its own, right now, for this operator?

        Four things must all hold, and the reason it fails is carried back so the
        proposal card can say plainly why a human is being asked.
        """
        cfg = ACTION_THRESHOLDS.get(threshold_key or "", {})
        meta = {
            "threshold_key": threshold_key, "action_key": cfg.get("action_key"),
            "label": cfg.get("label"), "class": "dual" if cfg.get("dual_control") else cfg.get("autonomy", "human"),
            "module_label": cfg.get("module_label"), "tab": cfg.get("tab"),
            "permission": cfg.get("permission"), "reversibility": cfg.get("reversibility"),
            "blast_radius": cfg.get("blast_radius"), "commits_spend": cfg.get("commits_spend", False),
            "why_human": cfg.get("why_human"), "approval_trigger": cfg.get("approval_trigger"),
            "value_ceiling_gbp": cfg.get("value_ceiling_gbp"),
            "severity_ceiling": cfg.get("severity_ceiling"), "confidence_floor": cfg.get("confidence_floor"),
            "dual_control": cfg.get("dual_control", False), "value_gbp": value_gbp,
        }
        needed = cfg.get("permission")
        if user_perms is not None and needed and not satisfies(user_perms, needed):
            return {**meta, "auto": False, "blocked": True,
                    "reason": f"You do not hold `{needed}`, so I cannot run this on your behalf."}
        if not synthetic_state.ai_mode:
            return {**meta, "auto": False,
                    "reason": "ATLAS is switched off — every action waits for a human while it is."}
        pseudo = {"severity": severity, "confidence": int(confidence), "value_gbp": value_gbp,
                  "action": {"threshold_key": threshold_key}, "batch": None}
        if agent_engine._action_auto_eligible(pseudo):
            return {**meta, "auto": True, "reason": "Autonomous class, inside every gate."}
        if meta["class"] == "dual":
            reason = "Dual control — two named approvers are required, so I never run it unaided."
        elif meta["class"] == "human":
            reason = cfg.get("why_human") or "This action class is always a human decision."
        elif value_gbp and cfg.get("commits_spend") and value_gbp >= agent_engine._guardrails["auto_approve_under_gbp"]:
            reason = (f"£{value_gbp:,.0f} is at or above the £"
                      f"{agent_engine._guardrails['auto_approve_under_gbp']:,} auto-approve guardrail.")
        elif cfg:
            reason = f"Outside a gate on this action ({cfg.get('approval_trigger') or 'threshold breached'})."
        else:
            reason = "No policy row covers this action, so it defaults to a human decision."
        return {**meta, "auto": False, "reason": reason}

    # ── read tools ──────────────────────────────────────────────────────────
    def _read_tool(self, name: str, args: dict) -> dict:
        if name == "query_state":
            section = str(args.get("section") or "").strip()
            if section not in _STATE_SECTIONS:
                return {"error": f"Unknown section '{section}'.", "available": sorted(_STATE_SECTIONS)}
            # A few sections are derived views rather than stored rows. Reading the
            # raw snapshot for these would hand ATLAS the telemetry without the
            # decision attached to it — for a boiler fault that means the signal
            # but not the part that clears it or whether we hold that part, which
            # is the half a question about the pipeline is actually asking.
            if section == "boiler_fault_pipeline":
                data = synthetic_state.get_fault_pipeline()
            else:
                data = synthetic_state.get_snapshot().get(section)
            limit = max(1, min(25, _num(args.get("limit"), 8)))
            search = str(args.get("search") or "").strip().lower()
            if isinstance(data, dict):
                if not search:
                    return {"section": section, "record": data}
                return {"section": section,
                        "record": {k: v for k, v in data.items() if search in json.dumps({k: v}, default=str).lower()}}
            rows = list(data or [])
            if search:
                rows = [r for r in rows if search in json.dumps(r, default=str).lower()]
            trimmed = [{k: v for k, v in r.items() if not isinstance(v, (list, dict)) or len(str(v)) < 400}
                       for r in rows[:limit]]
            return {"section": section, "matched": len(rows), "returned": len(trimmed), "records": trimmed}

        if name == "list_approvals":
            sev = str(args.get("severity") or "").strip().lower()
            recs = agent_engine._pending_recommendations()
            if sev:
                recs = [r for r in recs if r["severity"] == sev]
            return {"count": len(recs), "decisions": [{
                "recommendation_id": r["id"], "title": r["title"], "severity": r["severity"],
                "area": r.get("module_label"), "value_gbp": r.get("value_gbp"),
                "confidence": r.get("confidence"), "class": r.get("policy_autonomy"),
                "action": (r.get("action") or {}).get("label"),
                "executes": (r.get("action") or {}).get("executes"),
                "why_human": (r.get("governance") or {}).get("why_human"),
                "summary": r.get("summary"),
            } for r in recs[:15]]}

        if name == "list_resolution_options":
            kind, subject = str(args.get("kind") or ""), str(args.get("subject") or "")
            options = _resolution_options(kind, subject)
            if not options:
                return {"error": f"No open {kind or 'alert'} found for '{subject}'.",
                        "hint": "Check the subject id with query_state on van_stock_alerts, "
                                "locker_misses, carrier_movements or route_eta_risk."}
            return {"kind": kind, "subject": subject, "options": [{
                "action": o.get("action"), "label": o.get("label"), "what_it_does": o.get("detail"),
                "available": o.get("available"), "unavailable_reason": o.get("unavailable_reason"),
                "cost_gbp": o.get("cost_gbp"), "time_effect_mins": o.get("eta_mins"),
                "sla_impact": o.get("sla_impact"), "confidence": o.get("confidence"),
                "recommended": o.get("recommended"), "consequence": o.get("consequence"),
                "autonomy": (ACTION_THRESHOLDS.get(o.get("threshold_key") or "", {}).get("autonomy")),
            } for o in options]}

        if name == "explain_policy":
            q = str(args.get("search") or "").strip().lower()
            hits = [a for a in ACTION_CATALOG
                    if q in f"{a['label']} {a['key']} {a['description']} {a['module_label']} {a['tab']}".lower()]
            return {"matched": len(hits), "actions": [{
                "action": a["label"], "module": a["module_label"], "tab": a["tab"],
                "class": a["autonomy"], "permission": a["permission"],
                "when_a_human_decides": a["approval_trigger"], "why_human": a["why_human"],
                "reversibility": a["reversibility"], "blast_radius": a["blast_radius"],
                "gates": {"severity_ceiling": a["severity_ceiling"], "confidence_floor": a["confidence_floor"],
                          "value_ceiling_gbp": a["value_ceiling_gbp"], "commits_spend": a["commits_spend"]},
            } for a in hits[:8]]}

        return {"error": f"Unknown tool '{name}'."}

    # ── write tools ─────────────────────────────────────────────────────────
    def _describe(self, name: str, args: dict) -> tuple[str, str, str | None, int, str, int]:
        """(label, executes, threshold_key, value_gbp, severity, confidence) for a write call.

        The value and severity are what the governance gates are measured against,
        so they are derived from live state rather than taken from the model.
        """
        s = synthetic_state.get_snapshot()

        if name in ("approve_recommendation", "stage_for_approval"):
            rec = agent_engine._find(str(args.get("recommendation_id") or ""))
            if not rec:
                return ("Approve a queued decision", "Recommendation not found.", None, 0, "medium", 80)
            return (f"Approve · {rec['title']}", (rec.get("action") or {}).get("executes") or rec["title"],
                    (rec.get("action") or {}).get("threshold_key"), int(rec.get("value_gbp") or 0),
                    rec.get("severity", "medium"), int(rec.get("confidence") or 85))

        if name == "dismiss_recommendation":
            rec = agent_engine._find(str(args.get("recommendation_id") or ""))
            title = rec["title"] if rec else args.get("recommendation_id")
            return (f"Dismiss · {title}", f"Dismisses the decision with the reason: {args.get('reason')}",
                    "dismiss_recommendation", 0, "low", 80)

        if name == "apply_resolution":
            kind, subject, action = (str(args.get(k) or "") for k in ("kind", "subject", "action"))
            opt = _match_option(_resolution_options(kind, subject), action)
            # The alert's own severity governs the action; the option only prices it.
            alert = next((r for r in synthetic_state.recommended_resolutions(limit_per_kind=25)
                          if r["kind"] == kind and r["subject"] == subject), None)
            tk = (opt or {}).get("threshold_key") or (action if action in ACTION_THRESHOLDS else None)
            cost = int((opt or {}).get("cost_gbp") or (alert or {}).get("cost_gbp") or 0)
            sev = (alert or {}).get("severity", "medium")
            conf = int((opt or {}).get("confidence") or (alert or {}).get("confidence") or 85)
            label = ((opt or {}).get("label") or ACTION_THRESHOLDS.get(tk or "", {}).get("label")
                     or action.replace("_", " "))
            return (f"{label} · {subject}",
                    (opt or {}).get("detail") or f"Applies {action} to {kind} {subject}.",
                    tk, cost, sev, conf)

        if name == "raise_purchase_order":
            sku = str(args.get("sku_code") or "")
            qty = _num(args.get("quantity"), 0)
            po_type = str(args.get("po_type") or "standard").lower()
            item = next((i for i in s.get("inventory_positions", []) if i["sku_code"] == sku), None)
            unit = (item or {}).get("unit_cost_gbp") or 0
            value = int(qty * unit) if unit else 0
            sev = "high" if po_type == "emergency" else "medium"
            return (f"Raise {po_type} PO · {qty:,} × {sku}",
                    f"Raises a {po_type} purchase order for {qty:,} × {sku}"
                    + (f" (£{value:,})" if value else "") + ".",
                    "raise_po_emergency" if po_type == "emergency" else "raise_po_standard",
                    value, sev, 90)

        if name == "raise_transfer":
            sku, to = str(args.get("sku_code") or ""), str(args.get("to_warehouse") or "")
            qty = _num(args.get("quantity"), 0)
            item = next((i for i in s.get("inventory_positions", []) if i["sku_code"] == sku), None)
            value = int(qty * ((item or {}).get("unit_cost_gbp") or 0))
            return (f"Transfer {qty:,} × {sku} → {to}",
                    f"Raises an STO moving {qty:,} × {sku} into {to}.",
                    "raise_transfer", value, "medium", 90)

        if name == "expedite_purchase_order":
            po = str(args.get("po_number") or "")
            rec = next((p for p in s.get("purchase_orders", []) if p.get("po_number") == po), None)
            value = int((rec or {}).get("total_value_gbp") or 0)
            return (f"Expedite {po}", f"Pulls {po} forward; an expedite premium applies.",
                    "expedite_po", value, "medium", 88)

        if name == "acknowledge_exception":
            code = str(args.get("exception_code") or "")
            return (f"Acknowledge {code}", f"Takes ownership of {code} and starts its response clock.",
                    "acknowledge", 0, "medium", 92)

        if name == "activate_risk_plan":
            code = str(args.get("exception_code") or "")
            exc = next((e for e in s.get("exceptions", []) if e.get("exception_code") == code), None)
            sev = "critical" if (exc or {}).get("priority") == "P1" else "high"
            return (f"Activate the response plan for {code}",
                    f"Commits the network to the researched playbook behind {code}.",
                    "activate_plan", 0, sev, 90)

        if name == "resolve_exception":
            code = str(args.get("exception_code") or "")
            return (f"Resolve {code}", f"Closes {code} with root cause: {args.get('root_cause')}.",
                    "resolve_exception", 0, "high", 85)

        if name == "set_capability_autonomy":
            cid, lvl = str(args.get("capability_id") or ""), str(args.get("level") or "")
            nm = (AGENTS_BY_ID.get(cid) or {}).get("name", cid)
            return (f"Set {nm} autonomy → {lvl}", f"Changes how much {nm} may do unaided.",
                    "set_agent_autonomy", 0, "high", 85)

        if name == "set_ai_mode":
            on = bool(args.get("enabled"))
            return (f"Turn ATLAS {'on' if on else 'off'}",
                    ("Re-engages the autonomous layer." if on else
                     "Disables autonomy — every action then waits for a human."),
                    "toggle_ai_mode", 0, "critical", 90)

        return (name.replace("_", " "), "Unrecognised action.", None, 0, "medium", 70)

    def _execute(self, name: str, args: dict, by: str) -> dict:
        """Perform a write tool for real. The same state-engine entry points the
        modules and the approvals queue use — never a chat-only shortcut."""
        try:
            if name == "approve_recommendation":
                res = agent_engine.approve(str(args.get("recommendation_id") or ""), by)
                if not res.get("ok"):
                    return {"ok": False, "summary": res.get("error", "Could not approve.")}
                return {"ok": True, "summary": (res.get("result") or {}).get("summary", "Approved and executed.")}

            if name == "dismiss_recommendation":
                agent_engine.dismiss(str(args.get("recommendation_id") or ""), by, args.get("reason"))
                return {"ok": True, "summary": f"Dismissed — reason logged: {args.get('reason')}"}

            if name == "apply_resolution":
                kind, subject = str(args.get("kind")), str(args.get("subject"))
                options = _resolution_options(kind, subject)
                opt = _match_option(options, str(args.get("action")))
                if opt is None:
                    valid = ", ".join(str(o.get("action")) for o in options)
                    return {"ok": False, "summary": (
                        f"'{args.get('action')}' is not an option on {kind} {subject}."
                        + (f" Valid actions: {valid}." if valid else " There is no open alert with that id."))}
                if not opt.get("available", True):
                    return {"ok": False, "summary": (
                        f"{opt.get('label')} is not available here: "
                        f"{opt.get('unavailable_reason') or 'live state rules it out'}.")}
                res = synthetic_state.apply_resolution(kind, subject, str(opt["action"]), by)
                if res.get("error"):
                    return {"ok": False, "summary": res["error"]}
                return {"ok": True, "summary": res.get("summary", opt.get("label", "Resolution applied."))}

            if name == "raise_purchase_order":
                sku = str(args.get("sku_code") or "")
                item = next((i for i in synthetic_state.get_snapshot().get("inventory_positions", [])
                             if i["sku_code"] == sku), None)
                po = synthetic_state.create_purchase_order({
                    "sku_code": sku,
                    "supplier_code": args.get("supplier_code") or (item or {}).get("primary_supplier"),
                    "warehouse_code": args.get("warehouse_code") or (item or {}).get("warehouse_code") or "LEI_COE",
                    "po_type": str(args.get("po_type") or "standard").lower(),
                    "quantity": _num(args.get("quantity"), 0),
                    "notes": args.get("reason") or "Raised by ATLAS from the Ask ATLAS console.",
                })
                return {"ok": True, "summary": f"Raised {po.get('po_type')} PO {po['po_number']} — "
                                               f"{po.get('quantity'):,} × {sku} from "
                                               f"{po.get('supplier_name') or 'the primary supplier'} "
                                               f"(£{po.get('total_value_gbp', 0):,.0f}).",
                        "entity": {"po_number": po["po_number"]}}

            if name == "raise_transfer":
                sto = synthetic_state.create_transfer_order({
                    "sku_code": args.get("sku_code"), "to_warehouse": args.get("to_warehouse"),
                    "from_warehouse": args.get("from_warehouse"), "quantity": _num(args.get("quantity"), 0),
                    "notes": args.get("reason") or "Raised by ATLAS from the Ask ATLAS console.",
                })
                return {"ok": True, "summary": f"Raised transfer {sto['transfer_id']} — "
                                               f"{args.get('quantity')} × {args.get('sku_code')} into "
                                               f"{args.get('to_warehouse')}.",
                        "entity": {"transfer_id": sto["transfer_id"]}}

            if name == "expedite_purchase_order":
                synthetic_state.expedite_purchase_order(str(args.get("po_number")))
                return {"ok": True, "summary": f"Expedited {args.get('po_number')} — delivery pulled forward."}

            if name == "acknowledge_exception":
                synthetic_state.acknowledge_exception(str(args.get("exception_code")), by, args.get("notes"))
                return {"ok": True, "summary": f"Acknowledged {args.get('exception_code')} — owned by {by}."}

            if name == "activate_risk_plan":
                synthetic_state.activate_risk_plan(str(args.get("exception_code")), by)
                return {"ok": True, "summary": f"Activated the response plan for {args.get('exception_code')}."}

            if name == "resolve_exception":
                synthetic_state.resolve_exception(str(args.get("exception_code")), by,
                                                  str(args.get("root_cause") or "Resolved"), args.get("notes"))
                return {"ok": True, "summary": f"Resolved {args.get('exception_code')} — "
                                               f"root cause: {args.get('root_cause')}."}

            if name == "set_capability_autonomy":
                agent_engine.set_autonomy(str(args.get("capability_id")), str(args.get("level")))
                return {"ok": True, "summary": f"{args.get('capability_id')} autonomy set to {args.get('level')}."}

            if name == "set_ai_mode":
                agent_engine.set_ai_mode(bool(args.get("enabled")), by)
                return {"ok": True, "summary": f"ATLAS is now {'on' if args.get('enabled') else 'off'}."}

        except Exception as e:
            logger.warning("Ask-ATLAS action %s failed: %s", name, e)
            return {"ok": False, "summary": f"Could not complete: {e}"}
        return {"ok": False, "summary": f"Unknown action '{name}'."}

    def _log_action(self, label: str, summary: str, by: str, auto: bool) -> None:
        agent_engine._log(ORCH, kind="auto" if auto else "approved",
                          title=label, by=by,
                          detail=("Executed from Ask ATLAS · " if auto else "Approved in Ask ATLAS · ") + summary)
        agent_engine._save()

    # ── the conversation ────────────────────────────────────────────────────
    async def ask(self, question: str, history: list[dict] | None, user: dict) -> dict:
        by = user.get("sub") or user.get("name") or "operator"
        perms = set(user.get("permissions", []))
        digest = self.state_digest()

        steps: list[dict] = []       # what ATLAS did while answering — shown in the thread
        executed: list[dict] = []    # actions it performed on its own
        proposals: list[dict] = []   # actions waiting on this human

        fallback = agent_engine._deterministic_answer(
            question, synthetic_state.get_snapshot(), agent_engine._pending_recommendations())

        if not llm.llm_available():
            return self._envelope(fallback, "rules", digest, steps, executed, proposals)

        contents: list[dict] = []
        for turn in (history or [])[-MAX_HISTORY_TURNS:]:
            role = "model" if turn.get("role") in ("model", "assistant", "atlas") else "user"
            text = str(turn.get("text") or "")[:2000]
            if text:
                contents.append({"role": role, "parts": [{"text": text}]})
        contents.append({"role": "user", "parts": [{"text": question.strip()[:1500]}]})

        system = self._system_prompt(digest, by, perms)
        answer = ""

        for _round in range(MAX_TOOL_ROUNDS):
            res = await llm.converse(contents, system=system, tools=TOOLS, max_tokens=1400, temperature=0.3)
            if res is None:
                return self._envelope(fallback, "rules", digest, steps, executed, proposals)

            if not res["calls"]:
                answer = res["text"]
                break

            contents.append({"role": "model", "parts": res["parts"]})
            responses = []
            for call in res["calls"]:
                name, args = call["name"], call["args"]
                if name in READ_TOOLS:
                    out = self._read_tool(name, args)
                    steps.append({"kind": "read", "tool": name,
                                  "label": self._read_label(name, args, out)})
                else:
                    out = await self._handle_write(name, args, by, perms, executed, proposals, steps)
                responses.append({"functionResponse": {"name": name, "response": {"result": out}}})
            contents.append({"role": "user", "parts": responses})
        else:
            # Ran out of rounds still calling tools — ask for the answer with what it has.
            res = await llm.converse(contents, system=system, max_tokens=900, temperature=0.3)
            answer = (res or {}).get("text") or ""

        source = "gemini" if answer else "rules"
        answer = answer or fallback

        # An answer that says a card is waiting must leave one. If the model
        # promised and did not call, make the call for it; if even that fails,
        # take the promise out rather than ship a sentence pointing at nothing.
        if not proposals and not executed and _promises_card(answer):
            await self._keep_card_promise(contents, answer, system, by, perms,
                                          executed, proposals, steps)
            if not proposals:
                answer = _drop_card_promise(answer)

        return self._envelope(answer, source, digest, steps, executed, proposals)

    async def _keep_card_promise(self, contents: list[dict], answer: str, system: str,
                                 by: str, perms: set, executed: list, proposals: list,
                                 steps: list) -> None:
        """Make good on an approval card the answer claims to have prepared.

        The model is shown its own reply and required to call `stage_for_approval`
        — the one tool that cannot change anything, so the worst outcome of
        forcing it is a card the operator declines. That is strictly better than
        the alternative it produces on its own: an answer telling an operations
        director to approve something below, with nothing below it.
        """
        follow = list(contents) + [
            {"role": "model", "parts": [{"text": answer}]},
            {"role": "user", "parts": [{"text":
                "Your reply tells the operator a decision is staged for their approval, but you never "
                "called `stage_for_approval` — so there is no card under it and they cannot act on "
                "what you just recommended. Call it now for the decision you named, using its "
                "recommendation_id from the approvals queue in live state. Nothing executes: the call "
                "only renders the card you have already told them is there."}]},
        ]
        res = await llm.converse(follow, system=system, tools=TOOLS, max_tokens=200,
                                 temperature=0.1, force_tool="stage_for_approval")
        for call in (res or {}).get("calls") or []:
            if call["name"] == "stage_for_approval":
                await self._handle_write(call["name"], call["args"], by, perms,
                                         executed, proposals, steps)
                if proposals:
                    break

    async def _handle_write(self, name: str, args: dict, by: str, perms: set,
                            executed: list, proposals: list, steps: list) -> dict:
        """Route one action call through policy: run it, or park it for a human."""
        # Resolved before anything else reads the id, so the label on the card and
        # the decision it approves are the same decision.
        rec = None
        if name == "stage_for_approval":
            rec = _resolve_staged_rec(str(args.get("recommendation_id") or ""))
            if not rec:
                open_ids = [r["id"] for r in agent_engine._pending_recommendations()[:8]]
                return {"executed": False,
                        "error": f"No queued decision matches '{args.get('recommendation_id')}'.",
                        "open_recommendation_ids": open_ids,
                        "note": ("Call stage_for_approval again with one of these ids, or call "
                                 "list_approvals. Do NOT tell the operator anything is staged "
                                 "until a call succeeds.")}
            args = {**args, "recommendation_id": rec["id"]}

        label, executes, tk, value, severity, confidence = self._describe(name, args)
        gov = self._govern(tk, severity=severity, confidence=confidence, value_gbp=value, user_perms=perms)

        # Staging is not acting. The operator asked to SEE a decision, so it is
        # never executed here however permissive its policy is — it becomes a card
        # they press. Approving that card runs the real approval, so the action
        # still goes through exactly one execution path.
        if name == "stage_for_approval":
            g = rec.get("governance") or {}
            # A blocked card keeps its own explanation: "you do not hold write:transfer"
            # is the thing the operator needs to read, not the policy rationale
            # for why the decision is queued at all.
            gov = {**gov, "auto": False} if gov.get("blocked") else {
                **gov, "auto": False,
                "reason": g.get("why_human") or g.get("approval_trigger") or gov.get("reason")
                          or "This decision is queued for a human."}
            name, args = "approve_recommendation", {"recommendation_id": rec["id"]}

        if gov["auto"]:
            result = self._execute(name, args, by)
            if result.get("ok"):
                self._log_action(label, result["summary"], by, auto=True)
                entry = {"id": _pid(name, json.dumps(args, sort_keys=True, default=str), _now()),
                         "label": label, "summary": result["summary"], "governance": gov,
                         "tool": name, "at": _now()}
                executed.append(entry)
                steps.append({"kind": "action", "tool": name, "label": label, "detail": result["summary"]})
                return {"executed": True, "outcome": result["summary"],
                        "note": "Done — it ran autonomously under policy. Tell the operator what changed."}
            steps.append({"kind": "failed", "tool": name, "label": label, "detail": result["summary"]})
            return {"executed": False, "error": result["summary"]}

        pid = _pid(name, json.dumps(args, sort_keys=True, default=str))
        proposal = {
            "id": pid, "tool": name, "args": args, "label": label, "executes": executes,
            "governance": gov, "value_gbp": value, "severity": severity, "confidence": confidence,
            "created_at": _now(), "created_by": by, "status": "pending",
        }
        await self._remember(proposal)
        proposals.append({k: v for k, v in proposal.items() if k != "args"})
        steps.append({"kind": "proposal", "tool": name, "label": label, "detail": gov["reason"]})
        if gov.get("blocked"):
            # Staging something they cannot press is a dead end — say so in the
            # answer and offer one they can, rather than leaving them to discover
            # it by clicking a disabled button.
            return {"executed": False, "awaiting_approval": False, "proposal_id": pid,
                    "blocked": True, "why": gov["reason"],
                    "note": ("A card is shown below but its Approve button is DISABLED for this "
                             "operator — they lack the permission it requires. Say so plainly, name "
                             "the permission and who would hold it, and offer a decision they CAN "
                             "action instead.")}
        return {"executed": False, "awaiting_approval": True, "proposal_id": pid,
                "why": gov["reason"],
                "note": ("NOT run. An approval card is now rendered IN THIS CONVERSATION, directly "
                         "below your reply, with Approve and Decline buttons on it. Tell the operator "
                         "what you propose and why it needs them, then point them at the card below — "
                         "e.g. 'approve it below to release it'. Do NOT tell them to go to the "
                         "approvals queue or any other tab: this decision is made right here.")}

    @staticmethod
    def _read_label(name: str, args: dict, out: dict) -> str:
        if name == "query_state":
            n = out.get("returned", out.get("matched", 0))
            where = str(args.get("section") or "state").replace("_", " ")
            q = args.get("search")
            return f"Read {where}" + (f" · “{q}”" if q else "") + (f" · {n} record(s)" if n else "")
        if name == "list_approvals":
            return f"Read the approvals queue · {out.get('count', 0)} decision(s)"
        if name == "list_resolution_options":
            n = len(out.get("options") or [])
            return f"Read the options on {args.get('kind')} {args.get('subject')}" + (f" · {n}" if n else " · none")
        if name == "explain_policy":
            return f"Checked policy · “{args.get('search')}” · {out.get('matched', 0)} match(es)"
        return name

    def _system_prompt(self, digest: dict, by: str, perms: set) -> str:
        guard = agent_engine._guardrails
        return (
            "You are ATLAS, the master AI agent running a UK field-service logistics control tower "
            "(boilers, heat pumps, engineers, vans, warehouses, lockers, carriers). You are the only "
            "agent the operator knows about — never mention internal capability, team or agent names.\n\n"
            f"You are talking to {by}. It is {_now()}.\n\n"
            "HOW TO ANSWER\n"
            "· Ground every claim in the LIVE STATE below or in a tool result. Cite the actual numbers, "
            "codes and names. If something is not in state, say so plainly — never invent a figure.\n"
            "· Lead with the answer in one sentence, then the detail. Be concise and specific; an "
            "operations director is reading, not a chatbot enthusiast.\n"
            "· Use GitHub-flavoured markdown: `##` sub-headings only when the answer has real sections, "
            "`**bold**` for the numbers that matter, `-` bullets, markdown tables when comparing three or "
            "more things across the same fields, and `code` for SKU codes, PO numbers and exception codes.\n"
            "· British English, £ for money, 24h times. Keep it under ~250 words unless asked for depth.\n\n"
            "WHAT YOU CAN DO\n"
            "· `query_state` reads any section of raw live state — use it whenever the summary is not "
            "specific enough, rather than hedging.\n"
            "· The action tools change the network for real. Use them when the operator asks you to do "
            "something, or when they clearly agree to something you proposed. Do NOT act on a question "
            "that is only asking for information.\n"
            "· An answer that recommends something must let them take it. Whenever you name a queued "
            "decision as the one to approve — asked what needs approving, which to do first, what you "
            "would do, or when your answer surfaces decisions that are waiting — call "
            "`stage_for_approval` on the one or two you actually recommend. That does not execute "
            "anything; it renders an approval card under your reply. Answering 'I would approve X "
            "first' with no card leaves them to go and find X by hand, which is a failure.\n"
            "· CALL THE TOOL BEFORE YOU WRITE THE SENTENCE. Never write that you have staged, "
            "prepared or queued something for their approval unless a `stage_for_approval` result in "
            "this turn confirmed it — pass `recommendation_id` EXACTLY as it appears in "
            "approvals_queue below, copied character for character, never reconstructed from the "
            "title. A sentence promising a card with no card beneath it is worse than not "
            "recommending anything: they read it, look for the button, and find a broken page.\n"
            "· Policy decides what happens next, not you: routine, bounded, in-guardrail actions execute "
            "immediately; anything high-stakes comes back as an approval card.\n"
            "· That card is rendered IN THIS CONVERSATION, directly beneath your reply, with Approve and "
            "Decline buttons on it. When a tool result says an action is awaiting approval, say what you "
            "have prepared, why it needs a human, and direct them to the card below — never to the "
            "approvals queue, the AI panel or another tab. Never claim a pending action is done.\n"
            "· The application draws those cards itself. Write NO markup for them — no HTML, no XML, no "
            "tags such as <approval-card …/>, no placeholders and no brackets marking where one goes. "
            "Refer to them in plain prose ('approve it below'). Any tag you write is shown to the "
            "operator as literal text and reads as a broken page.\n"
            "· Never state that you have performed an action unless a tool result confirmed it.\n"
            f"· Guardrails: auto-approve under £{guard['auto_approve_under_gbp']:,}; dual control at or "
            f"above £{guard['requires_dual_control_over_gbp']:,}; hard ceiling £{guard['spend_ceiling_gbp']:,}.\n"
            f"· The operator holds these permissions: {', '.join(sorted(perms)) or 'none'} "
            "(`<verb>:all` covers every permission with that verb). Prefer actions and staged "
            "decisions they can actually authorise; if the best one is outside their permissions, "
            "say who it needs and offer them the best one they CAN action.\n\n"
            "LIVE STATE (JSON, generated this second):\n" + self._context_text(digest)
        )

    def _envelope(self, answer: str, source: str, digest: dict,
                  steps: list, executed: list, proposals: list) -> dict:
        health = digest.get("network_health", {})
        return {
            "answer": _strip_pseudo_markup(answer),
            "source": source,
            "model": get_model() if source == "gemini" else None,
            "grounded": True,
            "steps": steps,
            "executed": executed,
            "proposals": proposals,
            "suggestions": self._suggestions(digest),
            "state_stamp": {
                "health": health.get("state"),
                "pending_approvals": (digest.get("metrics") or {}).get("pending_approvals", 0),
                "open_exceptions": health.get("open_exceptions", 0),
                "ai_mode": digest.get("ai_mode_on"),
                "as_of": digest.get("as_of"),
            },
            "at": _now(),
        }

    @staticmethod
    def _suggestions(digest: dict) -> list[str]:
        """Follow-ups worth asking about THIS state, not a fixed list."""
        out: list[str] = []
        m = digest.get("metrics") or {}
        health = digest.get("network_health") or {}
        inv = digest.get("inventory") or {}
        alerts = digest.get("open_alerts") or {}
        if m.get("pending_approvals"):
            out.append("What needs my approval, and which would you approve first?")
        if health.get("open_p1"):
            out.append("Walk me through the open P1 and what you have already done.")
        if inv.get("red"):
            out.append("Which SKUs run out first, and what cover can you raise now?")
        if alerts.get("carrier_delays"):
            out.append("Fix the worst carrier delay.")
        if alerts.get("van_stock_total"):
            out.append("Sort out the vans that are short for tomorrow.")
        worst = next((s for s in digest.get("suppliers", []) if (s.get("otif") or 100) < 90), None)
        if worst:
            out.append(f"How bad is {worst['name']} and what are my options?")
        out.append("Summarise the network for my 08:00 stand-up.")
        return out[:5]

    async def proposal_states(self, conversation: dict) -> dict[str, dict]:
        """What became of every approval card in a stored conversation.

        A reopened thread must not offer a button that cannot be pressed, nor
        hide that the operator already approved something. Proposals are held in
        memory, so anything the ledger has forgotten is reported as expired
        rather than presented as still live."""
        states: dict[str, dict] = {}
        for msg in conversation.get("messages", []):
            for p in msg.get("proposals") or []:
                prop = await self._recall(p.get("id"))
                if prop is None:
                    states[p["id"]] = {"status": "expired",
                                       "summary": "This card is no longer live — ask me again and "
                                                  "I will re-prepare it."}
                elif prop["status"] != "pending":
                    states[p["id"]] = {"status": prop["status"], "summary": prop.get("result")
                                       or prop.get("decline_reason") or "Decided."}
        return states

    # ── human approval of a parked action ───────────────────────────────────
    async def execute_proposal(self, proposal_id: str, user: dict, decision: str,
                               reason: str | None = None) -> dict:
        prop = await self._recall(proposal_id)
        if not prop:
            return {"ok": False, "error": "That proposal has expired — ask me again and I will re-prepare it."}
        if prop["status"] != "pending":
            return {"ok": False, "error": f"Already {prop['status']}.", "proposal": prop}

        by = user.get("sub") or user.get("name") or "operator"
        if decision == "decline":
            prop.update(status="declined", decided_by=by, decided_at=_now(), decline_reason=reason)
            await self._remember(prop)
            agent_engine._log(ORCH, kind="dismissed", title=prop["label"], by=by,
                              detail=reason or "Declined in Ask ATLAS.")
            agent_engine._save()
            return {"ok": True, "decision": "declined", "proposal_id": proposal_id,
                    "summary": "Declined — nothing was changed.", "proposal": prop}

        needed = (prop.get("governance") or {}).get("permission")
        if needed and not satisfies(user.get("permissions", []), needed):
            return {"ok": False, "error": f"Approving this requires '{needed}'."}

        result = self._execute(prop["tool"], prop["args"], by)
        prop.update(status="executed" if result.get("ok") else "failed",
                    decided_by=by, decided_at=_now(), result=result.get("summary"))
        # Recorded before returning: an executed action whose record was lost
        # could be approved a second time from a reopened conversation.
        await self._remember(prop)
        if result.get("ok"):
            self._log_action(prop["label"], result["summary"], by, auto=False)
        return {"ok": result.get("ok", False), "decision": "approved", "proposal_id": proposal_id,
                "summary": result.get("summary"), "proposal": prop}


def get_model() -> str:
    """The model that actually answered — the operator's current selection, not
    whatever the environment was configured with at boot. Reported by its label,
    since an OpenRouter id ("anthropic/claude-sonnet-5") is a routing detail and
    the thread is read by operators, not by whoever set the key."""
    active = llm.current_model()
    return next((m["label"] for m in llm.MODELS if m["id"] == active), active)


atlas_chat = AtlasChat()
