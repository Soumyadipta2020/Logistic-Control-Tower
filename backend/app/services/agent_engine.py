"""
Agentic AI layer for the Logistics Control Tower.

A multi-agent fleet of capability-named specialists — one per control-tower
domain — that continuously SENSE live state, REASON deterministically over it,
and ACT. The fleet runs *autonomously by default*, but every action is gated by
its own OPTIMISED threshold: routine, low-value, high-confidence actions
self-execute within guardrails, while high-stakes ones (emergency spend, P1 plan
activation, supplier contingency, incident resolution) always escalate to a
human approval.

The roster and the per-action thresholds live in the synthetic state engine
(`app.synthetic.state`) — the single source of truth this module reasons over.
Everything here is deterministic; only the "Ask the Fleet" chat calls the LLM.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

from app.synthetic.state import synthetic_state, AGENT_FLEET_SPEC, ACTION_THRESHOLDS
from app.synthetic.actions import (ACTION_CATALOG, ACTION_BY_THRESHOLD, catalog_summary,
                                   AUTONOMY_CLASSES, MODULES)
from app.services import llm
from app.services import reasoning as R

logger = logging.getLogger("clt.agents")

_MODULE_LABELS = {path: meta["label"] for path, meta in MODULES.items()}

AUTONOMY_LEVELS = ("manual", "semi", "auto")
DEFAULT_AUTONOMY = "auto"  # autonomous by default, gated per action
SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "opportunity": 4}
_MAX_AUTO_PER_CYCLE = 8

_STATE_FILE = Path(__file__).resolve().parents[2] / "data" / "agent_state.json"
# Approvals arrive in bursts (an operator clearing a queue, or an autonomous
# cycle executing several actions in one pass). Coalesce them: only the last
# state in a burst is worth writing.
_SAVE_DEBOUNCE_S = 1.5


class _DebouncedWriter:
    """Persist a JSON payload without stalling the event loop.

    `agent_state.json` is ~1.7 MB — almost entirely reasoning traces, which are
    kept deliberately (see `_log`: an audit entry you cannot reconstruct the
    reasoning for is not auditable). It used to be written with a synchronous
    `write_text` called straight from `async def` approve/dismiss/rule handlers,
    so every click stalled all requests AND every WebSocket broadcast for the
    duration of the write.

    The split here is deliberate: `json.dumps` stays on the caller's thread —
    it is the cheap half, and running it on the loop is what makes the snapshot
    *consistent*, since the loop cannot yield mid-dump and no other thread can
    interleave a mutation. Only the slow, variable half — touching the disk —
    goes to a worker thread.

    Writes are also atomic now (tmp + `os.replace`). The old direct write had no
    rename, so a crash mid-write truncated the file, and `_load` swallowed the
    resulting decode error into a silent fresh start — losing every recorded
    decision without a word.
    """

    def __init__(self, path: Path):
        self._path = path
        self._pending: str | None = None
        self._lock = threading.Lock()

    def write(self, payload: str) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._write_now(payload)  # no loop (import time, sync tests) — inline is fine
            return
        with self._lock:
            # A flush is already scheduled iff something is pending; latest wins.
            schedule = self._pending is None
            self._pending = payload
        if schedule:
            loop.create_task(self._flush())

    async def _flush(self) -> None:
        await asyncio.sleep(_SAVE_DEBOUNCE_S)
        await self.flush_now()

    async def flush_now(self) -> None:
        """Write any pending payload immediately. Called on shutdown so a
        debounced write is never lost to a well-behaved exit."""
        with self._lock:
            payload, self._pending = self._pending, None
        if payload is not None:
            await asyncio.to_thread(self._write_now, payload)

    def _write_now(self, payload: str) -> None:
        tmp = self._path.with_name(self._path.name + ".tmp")
        try:
            tmp.write_text(payload, encoding="utf-8")
            os.replace(tmp, self._path)  # atomic — a crash leaves the previous file intact
        except Exception as e:
            logger.warning("Agent state save failed: %s", type(e).__name__)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass


_writer = _DebouncedWriter(_STATE_FILE)

# Roster comes from the state engine (source of truth); the studio agent is local.
AGENTS = list(AGENT_FLEET_SPEC)
CUSTOM_AGENT = {
    "id": "custom", "name": "Watch Rules", "role": "Your no-code alerts",
    "module": "/agents", "module_label": "Custom", "icon": "Gauge", "accent": "#EC4899",
    "sections": ["User-defined thresholds"],
    "mandate": "Runs the watch rules you author — no code. Fires a proposal whenever one of your "
               "conditions is met against live state.",
    "senses": ["User-defined thresholds"], "actions": [],
}
AGENTS_BY_ID = {a["id"]: a for a in AGENTS}
AGENTS_BY_ID[CUSTOM_AGENT["id"]] = CUSTOM_AGENT
ORCH = AGENTS_BY_ID["orchestrator"]

CUSTOM_METRICS = {
    "min_days_of_supply":  {"label": "Lowest days of supply (any SKU)", "unit": "d"},
    "amber_red_sku_count": {"label": "SKUs below reorder (amber + red)", "unit": ""},
    "min_supplier_otif":   {"label": "Lowest supplier OTIF", "unit": "%"},
    "open_exception_count": {"label": "Open exceptions", "unit": ""},
    "vor_count":           {"label": "Vehicles off road", "unit": ""},
    "min_throughput_pct":  {"label": "Lowest warehouse throughput vs baseline", "unit": "%"},
    "demand_uplift":       {"label": "Demand uplift factor", "unit": "x"},
}
_OPERATORS = {"<", "<=", ">", ">=", "=="}

_SKU_SUPPLIER = {
    "SKU-BLR-001": "VAI_UK", "SKU-BLR-002": "NAV_UK", "SKU-BLR-003": "VAI_UK",
    "SKU-BLR-004": "WOL_UK", "SKU-BLR-005": "WOL_UK",
    "SKU-HP-001": "MIT_HV", "SKU-HP-002": "DAI_EU",
    "SKU-SM-001": "LAND_UK", "SKU-EV-001": "ALF_NL",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sid(*parts) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:10]


class AgentEngine:
    def __init__(self) -> None:
        self._decisions: dict[str, dict] = {}
        self._activity: list[dict] = []
        self._rec_cache: dict[str, dict] = {}
        self._autonomy: dict[str, str] = {aid: DEFAULT_AUTONOMY for aid in AGENTS_BY_ID}
        self._fleet_autonomy: str = DEFAULT_AUTONOMY
        self._guardrails = {
            "auto_approve_under_gbp": 25_000,
            "spend_ceiling_gbp": 250_000,
            "requires_dual_control_over_gbp": 100_000,
            # Above this, a line is material enough to be decided on its own
            # merits and gets its own row in the queue. Below it, lines that
            # escalate for the SAME reason are one decision about that reason,
            # with the lines itemised on the row. This is what stops the queue
            # being a rolling window over an unbounded backlog.
            "individual_review_over_gbp": 50_000,
            # How many lines may be reviewed one-by-one before the exercise stops
            # being individual judgement. Under a network-wide shock the whole
            # value distribution shifts and a hundred lines clear the materiality
            # line at once — that is one situation to reason about, not a hundred
            # decisions. Beyond this count the remainder is grouped, and the group
            # says plainly why.
            "max_individual_reviews": 5,
        }
        self._agent_metrics: dict[str, dict] = {}
        self._proposed_ids: set[str] = set()
        # When each recommendation was FIRST raised. Recommendations are re-derived
        # from live state on every request, so without this every row would report
        # itself as seconds old — and "how long has this been waiting" is one of the
        # things an operator triages on.
        self._first_seen: dict[str, str] = {}
        # Which world the ledger above belongs to. See _sync_world().
        self._world_token: str | None = None
        self._custom_rules: list[dict] = []
        self._rule_counter = 0
        self._load()

    # ── persistence ─────────────────────────────────────────────────────────
    def _load(self) -> None:
        try:
            raw = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
            self._decisions = raw.get("decisions", {})
            self._activity = raw.get("activity", [])
            self._autonomy.update(raw.get("autonomy", {}))
            self._fleet_autonomy = raw.get("fleet_autonomy", DEFAULT_AUTONOMY)
            self._guardrails.update(raw.get("guardrails", {}))
            self._agent_metrics = raw.get("agent_metrics", {})
            self._proposed_ids = set(raw.get("proposed_ids", []))
            self._first_seen = raw.get("first_seen", {})
            self._world_token = raw.get("world_token")
            self._custom_rules = raw.get("custom_rules", [])
            self._rule_counter = raw.get("rule_counter", 0)
        except FileNotFoundError:
            pass
        except Exception as e:
            logger.warning("Agent state load failed (%s) — fresh start", type(e).__name__)
        if not self._activity:  # seed the feed from the state engine so it isn't empty
            try:
                self._activity = list(synthetic_state.get_snapshot().get("agent_layer", {}).get("seed_activity", []))
            except Exception:
                pass

    def _save(self) -> None:
        try:
            payload = json.dumps({
                # Decisions gate whether a recommendation re-appears as pending, so
                # this is capped generously and only from the oldest end. `_sync_world`
                # already clears it wholesale when the world is rebuilt.
                "decisions": dict(list(self._decisions.items())[-2000:]),
                "activity": self._activity[:200],
                "autonomy": self._autonomy, "fleet_autonomy": self._fleet_autonomy,
                "guardrails": self._guardrails, "agent_metrics": self._agent_metrics,
                "proposed_ids": list(self._proposed_ids)[-500:],
                "first_seen": dict(list(self._first_seen.items())[-500:]),
                "world_token": self._world_token,
                "custom_rules": self._custom_rules, "rule_counter": self._rule_counter,
            }, indent=0)
        except Exception as e:
            logger.warning("Agent state serialise failed: %s", type(e).__name__)
            return
        _writer.write(payload)

    # ── recommendation helper ───────────────────────────────────────────────
    def _rec(self, agent, subject, *, title, severity, confidence, summary,
             evidence, projected_impact, action, value_gbp=0, batch=None) -> dict:
        """One row in the approval queue = one DECISION.

        `batch` carries the line items when a single decision covers many items
        that differ only by subject — 23 replenishments that all escalate for the
        same reason are one decision about a policy breach, not 23 decisions. The
        lines stay attached so nothing is hidden: the operator expands the row and
        sees every SKU, quantity and value that approving it will commit."""
        return {
            "id": f"{agent['id']}:{_sid(agent['id'], subject)}",
            "agent_id": agent["id"], "agent_name": agent["name"], "agent_role": agent["role"],
            "agent_icon": agent["icon"], "agent_accent": agent["accent"], "module": agent["module"],
            "module_label": agent.get("module_label"), "section": (agent.get("sections") or [None])[0],
            "title": title, "severity": severity, "confidence": max(1, min(99, int(confidence))),
            "summary": summary, "evidence": evidence, "projected_impact": projected_impact,
            "action": action, "value_gbp": value_gbp, "batch": batch, "created_at": _now(),
        }

    def _resolution_recs(self, kinds: tuple, agent_id: str) -> list[dict]:
        """Turn the state engine's recommendations into approval-queue rows.

        The recommendation itself — WHICH action fixes this alert — is decided
        once, by the option engine, and read here rather than re-derived. What
        this adds is the queue's own concerns: a decision id, the evidence a
        human needs to sanity-check it, and the projected effect of pressing it.

        Every recommendation is offered, not only the ones needing a human. The
        policy gates downstream (`_action_auto_eligible`) decide which self-execute
        and which wait — so an operator can always see what ATLAS did as well as
        what it is asking for.
        """
        agent = AGENTS_BY_ID[agent_id]
        out: list[dict] = []
        try:
            recs = synthetic_state.recommended_resolutions(limit_per_kind=8, kinds=kinds)
        except Exception:
            return out
        for r in recs:
            opt = r["option"]
            evidence = [{"label": "Subject", "value": r["subject_label"]},
                        {"label": "Recommended", "value": opt["label"]}]
            if not r["recommended"]:
                # Honesty about the engine's own conviction: this was the best
                # available option, not one the catalogue actively endorses.
                evidence.append({"label": "Basis", "value": "Top-ranked option — no clear recommendation"})
            if opt.get("eta_mins") is not None:
                evidence.append({"label": "Time effect",
                                 "value": (f"recovers {abs(opt['eta_mins'])} min" if opt["eta_mins"] < 0
                                           else f"costs {opt['eta_mins']} min")})
            evidence.append({"label": "Cost", "value": f"£{opt['cost_gbp']:.2f}" if opt["cost_gbp"] else "No cost"})
            out.append(self._rec(
                agent, f"{r['kind']}:{r['subject']}",
                title=r["title"], severity=r["severity"], confidence=r["confidence"],
                summary=r["detail"], evidence=evidence,
                projected_impact=[{"label": "SLA impact", "value": opt.get("sla_impact") or "—",
                                   "direction": "up"}],
                value_gbp=r["cost_gbp"],
                action={"type": "resolution", "threshold_key": r["threshold_key"],
                        "label": opt["label"],
                        # The permission the action catalogue says this action
                        # needs — not a blanket one. Approving from the queue must
                        # demand exactly what performing it in the module demands,
                        # or the queue becomes a way around the permission model.
                        "requires_permission": (ACTION_THRESHOLDS.get(r["threshold_key"], {})
                                                .get("permission") or "read:field"),
                        "executes": opt["detail"],
                        "params": {"kind": r["kind"], "subject": r["subject"], "action": r["action"]}}))
        return out

    # ── public API ──────────────────────────────────────────────────────────
    def fleet(self) -> dict:
        self.run_autonomous_cycle()
        recs = self._pending_recommendations()
        by_agent: dict[str, list] = {}
        for r in recs:
            by_agent.setdefault(r["agent_id"], []).append(r)
        agents_out = []
        for a in list(AGENTS) + [CUSTOM_AGENT]:
            arecs = recs if a["id"] == "orchestrator" else by_agent.get(a["id"], [])
            top = min((SEVERITY_RANK[r["severity"]] for r in arecs), default=99)
            status = ("attention" if top <= SEVERITY_RANK["high"] else "advising" if arecs else "monitoring")
            agents_out.append({**a, "autonomy": self._autonomy.get(a["id"], DEFAULT_AUTONOMY),
                               "pending_count": len(arecs), "status": status, "trust": self._trust(a["id"])})
        return {
            "autonomy": self._fleet_autonomy, "autonomy_levels": list(AUTONOMY_LEVELS),
            "guardrails": self._guardrails, "action_thresholds": ACTION_THRESHOLDS,
            "agents": agents_out, "metrics": self.metrics(recs), "briefing": self._briefing(recs),
            "custom_rules": self.list_rules(), "custom_metrics": self._custom_metric_catalog(),
            # The reasoning layer, and the models the operator may switch between.
            "llm": {"enabled": llm.llm_available(),
                    "model": llm.current_model() if llm.llm_available() else None,
                    "model_label": next((m["label"] for m in llm.MODELS if m["id"] == llm.current_model()),
                                        llm.current_model()) if llm.llm_available() else None,
                    "provider": llm.current_provider() if llm.llm_available() else None,
                    "provider_label": (llm.PROVIDER_LABELS.get(llm.current_provider())
                                       if llm.llm_available() else None),
                    "models": llm.model_catalog()},
            # Governance surface: every action a user can take, what ATLAS may do
            # with it, and when a human must decide. The Governance tab renders
            # this verbatim — policy and UI can never drift apart.
            "action_catalog": ACTION_CATALOG,
            "catalog_summary": catalog_summary(),
            "autonomy_classes": AUTONOMY_CLASSES,
            # The master switch and the AI-ON/AI-OFF variation of the current state.
            "ai_mode": synthetic_state.ai_mode,
            "ai_response": synthetic_state.ai_response().get("summary", {}),
            "health": synthetic_state.health_state(),
            "generated_at": _now(),
        }

    def set_ai_mode(self, enabled: bool, by: str = "operator") -> dict:
        """Master switch. Delegates to the state engine, which re-applies the
        current state through the other variation, then records the change."""
        result = synthetic_state.set_ai_mode(enabled)
        self._log(ORCH, kind="governance",
                  title=f"ATLAS turned {'on' if enabled else 'off'}",
                  detail=("Autonomous layer engaged — routine actions self-execute within guardrails."
                          if enabled else
                          "Autonomous layer disabled — every action now waits for a human."),
                  by=by)
        self._save()
        return result

    def metrics(self, recs=None) -> dict:
        recs = recs if recs is not None else self._pending_recommendations()
        today = datetime.now(timezone.utc).date().isoformat()
        def _t(outcome):
            return sum(1 for d in self._decisions.values() if d["outcome"] == outcome and d["at"][:10] == today)
        senses = {s for a in AGENTS for s in a.get("senses", [])}
        # Actions the state engine's AI-ON variation executed count as auto-executed
        # too — they are the same fleet doing the same work at scenario-apply time.
        layer_auto = len([e for e in self._ai_layer_activity() if e.get("kind") == "auto"])
        auto_today = _t("auto") + layer_auto
        return {
            "agents_total": len(AGENTS), "agents_engaged": len({r["agent_id"] for r in recs}),
            "pending_approvals": len(recs), "critical_pending": sum(1 for r in recs if r["severity"] in ("critical", "high")),
            "actions_executed_today": _t("approved") + auto_today, "auto_executed_today": auto_today,
            "signals_monitored": len(senses) + len(self._custom_rules), "autonomy": self._fleet_autonomy,
            "ai_mode": synthetic_state.ai_mode,
        }

    def recommendations(self, agent_id=None) -> list[dict]:
        self.run_autonomous_cycle()
        recs = self._pending_recommendations()
        if agent_id and agent_id != "orchestrator":
            recs = [r for r in recs if r["agent_id"] == agent_id]
        return recs

    def activity(self, limit=40) -> list[dict]:
        """THE audit trail. Three producers, one feed.

        An operator should never have to know which layer performed an action in
        order to find it, so this merges all three:

          · `_activity`          — decisions taken through the approvals queue,
                                   whether ATLAS self-executed them or a human
                                   approved them, plus governance changes.
          · `_ai_layer_activity` — what the AI-ON variation executed when the
                                   current scenario was applied.
          · `_module_activity`   — actions taken straight off a module screen,
                                   which never touched the queue at all.

        That last one used to be missing, and its absence was a hole in the
        product's central claim: a dispatcher resolving a van alert or a late
        round on the module page produced a real, catalogued, governed action
        that the "decision & action audit trail" simply did not contain.
        """
        merged = self._ai_layer_activity() + self._activity + self._module_activity()
        seen, out = set(), []
        for e in merged:
            key = (e.get("title"), (e.get("ts") or "")[:16])
            if key in seen:
                continue
            seen.add(key)
            out.append(e)
        out.sort(key=lambda e: e.get("ts") or "", reverse=True)
        return out[:limit]

    @staticmethod
    def _ai_layer_activity() -> list[dict]:
        try:
            layer = synthetic_state.get_snapshot().get("agent_layer", {}) or {}
            return list(layer.get("ai_activity", []) or [])
        except Exception:
            return []

    @staticmethod
    def _module_activity() -> list[dict]:
        """Resolutions applied directly on a module screen, as audit entries.

        Rows the approvals queue executed are already in `self._activity` — the
        `source` stamp set in `apply_resolution` is what tells the two apart, so
        nothing is counted twice. Everything else here is a dispatcher pressing an
        option on a van alert, a locker miss, a late carrier leg or a late round.
        """
        try:
            log = synthetic_state.get_snapshot().get("resolution_log", []) or []
        except Exception:
            return []
        out = []
        for e in log:
            if e.get("source") == "agent_queue":
                continue
            by = e.get("by") or ""
            out.append({
                "ts": e.get("at"),
                "agent_id": "orchestrator", "agent_name": ORCH["name"],
                "module": e.get("module"), "module_label": e.get("module_label"),
                "tab": e.get("tab"), "section": e.get("section"),
                "threshold_key": e.get("threshold_key"), "action_key": e.get("action_key"),
                # `operator` is its own kind: it was neither self-executed by the
                # fleet nor approved from the queue — somebody did it on the page.
                "kind": "auto" if by.startswith("fleet-auto") else "operator",
                "title": e.get("action_label") or e.get("summary"),
                "detail": e.get("summary"), "by": by or "operator", "trace": None,
            })
        return out

    # ── what was actioned today, per module and per section ──────────────────
    def actions_today(self) -> dict:
        """Today's completed actions, grouped the way the product is navigated.

        Every module that lets ATLAS act autonomously needs to answer the same
        question on the page itself: *what has actually been done here today?*
        Live state cannot answer it — an autonomous action's whole purpose is to
        return the network to normal, so a healthy screen looks identical whether
        ATLAS worked all morning or did nothing at all. Only the audit trail knows
        the difference, and this is that trail counted.

        Grouping is by (module, section) read off the action catalogue, so a
        counter placed on a section counts exactly the actions the Governance tab
        lists for that section — the two can never disagree.
        """
        today = datetime.now(timezone.utc).date().isoformat()
        rows = [e for e in self.activity(limit=1000)
                if (e.get("ts") or "")[:10] == today
                and e.get("kind") in ("auto", "approved", "operator")]

        def _blank(**ident):
            return {**ident, "actions": 0, "auto": 0, "approved": 0, "operator": 0,
                    "latest_at": None, "sections": {}}

        total = _blank()
        modules: dict[str, dict] = {}
        for e in rows:
            tk = e.get("threshold_key")
            cfg = ACTION_THRESHOLDS.get(tk or "", {})
            module = e.get("module") or cfg.get("module")
            if not module:
                # Older engine entries predate the stamp; fall back to the label
                # so they still count towards the module total even without a
                # section to attribute them to.
                module = next((m for m, lbl in _MODULE_LABELS.items()
                               if lbl == e.get("module_label")), None)
            if not module:
                continue
            section = e.get("section") or cfg.get("section")
            kind = e["kind"]
            m = modules.setdefault(module, _blank(
                module=module, module_label=e.get("module_label") or cfg.get("module_label")
                or _MODULE_LABELS.get(module, module)))
            for bucket in (total, m):
                bucket["actions"] += 1
                bucket[kind] += 1
                if not bucket["latest_at"] or e["ts"] > bucket["latest_at"]:
                    bucket["latest_at"] = e["ts"]
            if section:
                sec = m["sections"].setdefault(section, _blank(section=section))
                sec.pop("sections", None)
                sec["actions"] += 1
                sec[kind] += 1
                if not sec["latest_at"] or e["ts"] > sec["latest_at"]:
                    sec["latest_at"] = e["ts"]
        total.pop("sections", None)
        return {"date": today, "total": total, "modules": modules, "generated_at": _now()}

    # ── trust / grading ───────────────────────────────────────────────────────
    def _trust(self, agent_id) -> dict:
        m = self._agent_metrics.get(agent_id, {})
        a, d = m.get("approved", 0), m.get("dismissed", 0)
        sample = a + d
        score = 72 if sample == 0 else round(100 * a / sample)
        return {"score": score, "approved": a, "dismissed": d, "auto_executed": m.get("auto_executed", 0),
                "proposed": m.get("proposed", 0), "sample": sample, "auto_eligible": sample >= 3 and score >= 75}

    def _bump(self, agent_id, key) -> None:
        m = self._agent_metrics.setdefault(agent_id, {})
        m[key] = m.get(key, 0) + 1

    # ── governance ────────────────────────────────────────────────────────────
    def set_autonomy(self, agent_id, level) -> dict:
        if level not in AUTONOMY_LEVELS:
            raise ValueError(f"level must be one of {AUTONOMY_LEVELS}")
        if agent_id in ("fleet", "all"):
            self._fleet_autonomy = level
            for k in self._autonomy:
                self._autonomy[k] = level
            who = "Fleet"
        elif agent_id in self._autonomy:
            self._autonomy[agent_id] = level
            who = AGENTS_BY_ID[agent_id]["name"]
        else:
            raise KeyError(agent_id)
        self._log(ORCH, kind="governance", title=f"Autonomy → {level.title()}",
                  detail=f"{who} now operating at {level} autonomy.")
        self._save()
        return {"agent_id": agent_id, "autonomy": level, "fleet_autonomy": self._fleet_autonomy}

    def set_guardrails(self, patch: dict) -> dict:
        allowed = {"auto_approve_under_gbp", "spend_ceiling_gbp", "requires_dual_control_over_gbp"}
        for k, v in patch.items():
            if k in allowed and isinstance(v, (int, float)) and v >= 0:
                self._guardrails[k] = int(v)
        self._log(ORCH, kind="governance", title="Guardrails updated",
                  detail=f"Auto-approve under £{self._guardrails['auto_approve_under_gbp']:,}.")
        self._save()
        return self._guardrails

    # ── watch-rule studio ────────────────────────────────────────────────────
    def _custom_metric_catalog(self) -> list[dict]:
        return [{"key": k, **v} for k, v in CUSTOM_METRICS.items()]

    def list_rules(self) -> list[dict]:
        state = synthetic_state.get_snapshot()
        out = []
        for rule in self._custom_rules:
            val, ctx = self._metric_value(rule["metric"], state)
            out.append({**rule, "current_value": val, "context": ctx,
                        "firing": self._cmp(val, rule["operator"], rule["threshold"])})
        return out

    def add_rule(self, data: dict) -> dict:
        metric = data.get("metric")
        if metric not in CUSTOM_METRICS:
            raise ValueError(f"metric must be one of {list(CUSTOM_METRICS)}")
        op = data.get("operator")
        if op not in _OPERATORS:
            raise ValueError(f"operator must be one of {sorted(_OPERATORS)}")
        try:
            threshold = float(data["threshold"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("threshold must be a number")
        sev = data.get("severity", "medium")
        if sev not in SEVERITY_RANK:
            sev = "medium"
        self._rule_counter += 1
        rule = {"id": f"WR-{self._rule_counter:03d}",
                "name": (data.get("name") or f"{CUSTOM_METRICS[metric]['label']} {op} {threshold:g}").strip(),
                "metric": metric, "operator": op, "threshold": threshold, "severity": sev,
                "created_by": data.get("created_by", "operator"), "created_at": _now()}
        self._custom_rules.append(rule)
        self._log(CUSTOM_AGENT, kind="governance", title=f"Watch rule created: {rule['name']}",
                  detail=f"Fires when {CUSTOM_METRICS[metric]['label']} {op} {threshold:g}.", by=rule["created_by"])
        self._save()
        return rule

    def delete_rule(self, rule_id: str) -> dict:
        before = len(self._custom_rules)
        self._custom_rules = [r for r in self._custom_rules if r["id"] != rule_id]
        self._save()
        return {"ok": len(self._custom_rules) < before, "rule_id": rule_id}

    # ── decisions ─────────────────────────────────────────────────────────────
    def approve(self, rec_id, by) -> dict:
        prior = self._decisions.get(rec_id)
        if prior:
            return {"ok": False, "error": f"Already {prior['outcome']} by {prior['by']}."}
        rec = self._find(rec_id)
        if not rec:
            return {"ok": False, "error": "Recommendation is no longer applicable."}
        result = self._execute(rec, by)
        auto = by == "fleet-auto"
        # Stamp the trace with what actually happened, so the audit entry records
        # the decision AND its execution rather than the proposal alone.
        trace = rec.get("trace")
        if trace:
            trace = {**trace, "decision": {**trace["decision"], "executed": True, "executed_by": by,
                                           "outcome": "auto_executed" if auto else "human_approved",
                                           "execution_result": result.get("summary")}}
        self._decisions[rec_id] = {"outcome": "auto" if auto else "approved", "by": by, "at": _now(),
                                   "result": result.get("summary"), "trace_id": (trace or {}).get("trace_id")}
        self._bump(rec["agent_id"], "auto_executed" if auto else "approved")
        self._log(AGENTS_BY_ID[rec["agent_id"]], kind="auto" if auto else "approved", title=rec["title"], by=by,
                  detail=(("Auto-executed within guardrails · " if auto else "") + result.get("summary", rec["action"]["executes"])),
                  trace=trace, threshold_key=(rec.get("action") or {}).get("threshold_key"))
        self._save()
        return {"ok": True, "recommendation_id": rec_id, "result": result, "auto": auto}

    def dismiss(self, rec_id, by, reason=None) -> dict:
        rec = self._find(rec_id)
        agent = AGENTS_BY_ID.get(rec["agent_id"]) if rec else ORCH
        self._decisions[rec_id] = {"outcome": "dismissed", "by": by, "at": _now(), "reason": reason}
        if rec:
            self._bump(rec["agent_id"], "dismissed")
        trace = (rec or {}).get("trace")
        if trace:
            trace = {**trace, "decision": {**trace["decision"], "outcome": "human_overrode",
                                           "executed": False, "executed_by": by,
                                           "override_reason": reason or "No reason given."}}
        self._log(agent, kind="dismissed", title=rec["title"] if rec else rec_id, by=by,
                  detail=reason or "Dismissed by operator.", trace=trace,
                  threshold_key=((rec or {}).get("action") or {}).get("threshold_key"))
        self._save()
        return {"ok": True, "recommendation_id": rec_id}

    # ── governed auto-execution (per-action optimised thresholds) ─────────────
    def _action_auto_eligible(self, rec) -> bool:
        """Policy check only (ignores the master switch): may THIS action class
        self-execute at its current severity / value / confidence?"""
        cfg = ACTION_THRESHOLDS.get((rec.get("action") or {}).get("threshold_key"))
        if not cfg or cfg["autonomy"] != "auto":
            return False
        if SEVERITY_RANK[rec["severity"]] < SEVERITY_RANK[cfg["severity_ceiling"]]:
            return False
        if rec["confidence"] < cfg["confidence_floor"]:
            return False
        if cfg.get("dual_control"):
            return False   # a second approver is required — never self-executed
        v = rec.get("value_gbp", 0) or 0
        batch = rec.get("batch")
        # A batch of independently-authorised lines is many exercises of the same
        # mandate, not one large commitment: "you may raise a PO under £25k" is
        # satisfied by twenty £5k orders. So the per-action ceiling is tested
        # against the LARGEST LINE, while the aggregate is held to the global
        # spend ceiling — which is the guardrail that exists for exactly this.
        line_value = batch["max_line_gbp"] if batch else v
        if v > 0:
            # The global guardrails are SPEND limits: they bite on actions that
            # commit money, not on ones that relocate stock already owned.
            caps = [cfg["value_ceiling_gbp"]]
            if cfg.get("commits_spend"):
                caps.append(self._guardrails["auto_approve_under_gbp"])
            caps = [x for x in caps if x > 0]
            if caps and line_value > min(caps):
                return False
            if cfg.get("commits_spend"):
                if line_value >= self._guardrails["requires_dual_control_over_gbp"]:
                    return False
                if v > self._guardrails["spend_ceiling_gbp"]:
                    return False   # aggregate exceeds what any agent may commit unaided
        return True

    def run_autonomous_cycle(self) -> int:
        # The master switch is absolute: with ATLAS off, nothing self-executes and
        # every proposal waits for a human — which is exactly the AI-OFF variation.
        if not synthetic_state.ai_mode:
            return 0
        if not any(v == "auto" for v in self._autonomy.values()):
            return 0
        executed = 0
        for rec in self._pending_recommendations():
            if executed >= _MAX_AUTO_PER_CYCLE:
                break
            if self._autonomy.get(rec["agent_id"]) == "auto" and self._action_auto_eligible(rec):
                if self.approve(rec["id"], "fleet-auto").get("ok"):
                    executed += 1
        return executed

    # ── internals ─────────────────────────────────────────────────────────────
    def _find(self, rec_id):
        for r in self._pending_recommendations(include_decided=True):
            if r["id"] == rec_id:
                return r
        return self._rec_cache.get(rec_id)

    def _sync_world(self) -> None:
        """Drop everything that only makes sense inside one world.

        Recommendation ids are a deterministic hash of (capability, subject), so a
        SKU that goes short again in a NEW world gets the SAME id it had in the old
        one. Without this, a decision taken before a scenario was applied keeps
        suppressing the recommendation the scenario raises — the approvals queue
        silently empties and the Approve button has nothing left to act on.

        The audit trail is deliberately NOT cleared: those actions really happened
        and the operator must still be able to see them. What is cleared is only
        the bookkeeping that decides what is still OUTSTANDING."""
        token = synthetic_state.world_token
        if token == self._world_token:
            return
        dropped = len(self._decisions)
        self._decisions = {}
        self._proposed_ids = set()
        self._first_seen = {}
        self._rec_cache = {}
        self._world_token = token
        if dropped:
            logger.info("World rebuilt — cleared %d stale decision(s); the queue re-derives "
                        "from the new state.", dropped)
        self._save()

    def _pending_recommendations(self, include_decided=False) -> list[dict]:
        self._sync_world()
        state = synthetic_state.get_snapshot()
        recs: list[dict] = []
        for gen in (self._gen_replenishment, self._gen_exceptions, self._gen_supplier,
                    self._gen_transport, self._gen_demand_sensing, self._gen_visibility,
                    self._gen_sustainability, self._gen_custom):
            try:
                recs.extend(gen(state))
            except Exception:
                continue
        for r in recs:
            self._rec_cache[r["id"]] = r
            tk = (r.get("action") or {}).get("threshold_key")
            cfg = ACTION_THRESHOLDS.get(tk, {})
            r["policy_autonomy"] = "dual" if cfg.get("dual_control") else cfg.get("autonomy", "human")
            r["would_auto"] = self._action_auto_eligible(r)
            # Governance context, carried on the row so the approvals table can
            # show WHY this needs a human without a second round-trip.
            r["governance"] = {
                "action_key": cfg.get("action_key"), "threshold_key": tk,
                "class": r["policy_autonomy"], "module": cfg.get("module"),
                "module_label": cfg.get("module_label"), "tab": cfg.get("tab"),
                "reversibility": cfg.get("reversibility"), "blast_radius": cfg.get("blast_radius"),
                "sla_minutes": cfg.get("sla_minutes"), "commits_spend": cfg.get("commits_spend", False),
                "approval_trigger": cfg.get("approval_trigger"), "why_human": cfg.get("why_human"),
                "severity_ceiling": cfg.get("severity_ceiling"),
                "confidence_floor": cfg.get("confidence_floor"),
                "value_ceiling_gbp": cfg.get("value_ceiling_gbp"),
                "dual_control": cfg.get("dual_control", False),
            }
            # The full stack: signals → reasoning → cross-agent negotiation →
            # arbitration → policy gates → decision.
            r["trace"] = self._trace(r, state, cfg)
            r["consensus"] = r["trace"]["arbitration"]["consensus_score"]
            r["objections"] = r["trace"]["arbitration"]["objections"]
            r["conditions"] = r["trace"]["decision"]["conditions"]
            r["created_at"] = self._first_seen.setdefault(r["id"], r["created_at"])
            if r["id"] not in self._proposed_ids:
                self._proposed_ids.add(r["id"])
                self._bump(r["agent_id"], "proposed")
        if not include_decided:
            recs = [r for r in recs if r["id"] not in self._decisions]
        recs.sort(key=lambda r: (SEVERITY_RANK.get(r["severity"], 9), -r["confidence"]))
        return recs

    # ── decision tracing ─────────────────────────────────────────────────────
    def _trace(self, rec, state, cfg) -> dict:
        """Reconstruct how this recommendation came to exist: the signals the
        capability read, the steps it reasoned through, who it consulted and what
        they argued, how ATLAS settled it, and which governance gate decided
        whether it runs or waits for a human."""
        params = (rec.get("action") or {}).get("params", {}) or {}
        ctx = R.build_context(
            state, value_gbp=rec.get("value_gbp", 0), severity=rec["severity"],
            confidence=rec["confidence"], supplier_code=params.get("supplier_code"),
            sku_code=params.get("sku_code"))
        # The evidence the generator already gathered IS the sensed signal set —
        # reusing it keeps the trace and the card telling the same story.
        signals = [{"label": e.get("label"), "value": e.get("value"),
                    "detail": e.get("detail"), "source": rec.get("module_label")}
                   for e in (rec.get("evidence") or [])]
        steps = [
            {"step": 1, "rule": f"{rec['agent_name']} · trigger condition for {cfg.get('label', 'this action')}",
             "observation": "; ".join(f"{e.get('label')} = {e.get('value')}" for e in (rec.get("evidence") or [])[:3]),
             "inference": rec["summary"].split(". ")[0] + ".", "confidence": rec["confidence"]},
            {"step": 2, "rule": "Projected impact is stated before the action is proposed",
             "observation": "; ".join(f"{i.get('label')} → {i.get('value')}" for i in (rec.get("projected_impact") or [])),
             "inference": "The action is proposed on the strength of that projection, not on the alert alone.",
             "confidence": rec["confidence"]},
            {"step": 3, "rule": "Reversibility and blast radius cap the autonomy available",
             "observation": f"{cfg.get('reversibility', 'reversible')} · {cfg.get('blast_radius', 'record')}-level",
             "inference": (cfg.get("why_human") or
                           "Bounded and recoverable — eligible for autonomous execution on policy."),
             "confidence": rec["confidence"]},
        ]
        return R.build_trace(
            action_key=cfg.get("action_key") or (rec.get("action") or {}).get("threshold_key", ""),
            threshold_key=(rec.get("action") or {}).get("threshold_key", ""),
            owner_agent=rec["agent_id"], subject=rec["title"], cfg=cfg, ctx=ctx,
            guardrails=self._guardrails, signals=signals, reasoning=steps,
            proposal=rec["summary"],
            alternatives=synthetic_state.action_alternatives(
                {"threshold_key": (rec.get("action") or {}).get("threshold_key", "")}),
            agent_autonomy=self._autonomy.get(rec["agent_id"], DEFAULT_AUTONOMY),
            ai_enabled=synthetic_state.ai_mode, executed=False)

    def _briefing(self, recs) -> dict:
        crit = [r for r in recs if r["severity"] == "critical"]
        high = [r for r in recs if r["severity"] == "high"]
        opps = [r for r in recs if r["severity"] == "opportunity"]
        if not recs:
            headline = "All clear. Every domain is inside tolerance — I have nothing to escalate."
        elif crit:
            headline = (f"{len(crit)} critical decision{'s' if len(crit) != 1 else ''} escalated for approval — "
                        f"top: {crit[0]['title']}.")
        elif high:
            headline = (f"{len(high)} high-priority proposal{'s' if len(high) != 1 else ''} awaiting review — top: {high[0]['title']}.")
        else:
            headline = (f"{len(recs)} proposal{'s' if len(recs) != 1 else ''} escalated; nothing critical. "
                        "Routine actions are self-executing within guardrails.")
        return {"headline": headline, "opportunity_count": len(opps),
                "top": [{"id": r["id"], "agent_name": r["agent_name"], "title": r["title"], "severity": r["severity"]} for r in recs[:3]]}

    def _log(self, agent, *, kind, title, detail="", by=None, trace=None,
             threshold_key=None) -> None:
        # The trace travels with the audit entry: an action in the log you cannot
        # reconstruct the reasoning for is not actually auditable.
        #
        # The threshold key travels with it too, and where the action sits in the
        # product is resolved from the catalogue rather than restated — that is
        # what lets `actions_today` attribute this entry to the exact section the
        # Governance tab lists it under.
        cfg = ACTION_THRESHOLDS.get(threshold_key or "", {})
        self._activity.insert(0, {"ts": _now(), "agent_id": agent.get("id"), "agent_name": agent.get("name"),
                                  "module_label": cfg.get("module_label") or agent.get("module_label"),
                                  "module": cfg.get("module") or agent.get("module"),
                                  "tab": cfg.get("tab"), "section": cfg.get("section"),
                                  "threshold_key": threshold_key, "action_key": cfg.get("action_key"),
                                  "kind": kind, "title": title, "detail": detail, "by": by,
                                  "trace": trace})
        del self._activity[200:]

    def _execute(self, rec, by) -> dict:
        t, p = rec["action"]["type"], rec["action"].get("params", {})
        # `fleet-auto` is the one caller with no human behind it — the id
        # `run_autonomous_cycle` passes to `approve()`. A PO raised under that
        # name is stamped with the recommendation's own reasoning, so the
        # "auto-generated" badge and its tooltip trace to the SAME evidence the
        # approvals queue showed a human, rather than a caller-invented string.
        auto = by == "fleet-auto"
        auto_meta = {"is_auto_generated": True, "auto_reason": rec.get("summary")} if auto else {}
        try:
            if t == "raise_po":
                po = synthetic_state.create_purchase_order({**p, **auto_meta})
                return {"summary": f"Raised {po.get('po_type', 'standard')} PO {po['po_number']} — {po.get('quantity')} × "
                                   f"{p.get('sku_code')} from {po.get('supplier_name', p.get('supplier_code'))}.", "entity": po}
            if t == "raise_po_batch":
                # One approval, every line committed. Partial failures are reported
                # rather than swallowed — an operator who approved 23 orders needs
                # to know if only 21 landed.
                raised, failed, value = [], [], 0
                for line in p.get("lines", []):
                    try:
                        po = synthetic_state.create_purchase_order({
                            "sku_code": line["sku_code"], "supplier_code": line["supplier_code"],
                            "warehouse_code": line.get("warehouse_code", "LEI_COE"),
                            "po_type": line.get("po_type", p.get("po_type", "standard")),
                            "quantity": line["quantity"],
                            "notes": "Replenishment Agent — grouped replenishment decision.",
                            **auto_meta})
                        raised.append(po["po_number"])
                        value += line["value_gbp"]
                    except Exception as exc:
                        failed.append(f"{line['sku_code']} ({exc})")
                summary = (f"Raised {len(raised)} {p.get('po_type', 'standard')} PO(s) covering £{value:,} "
                           f"— {', '.join(raised[:4])}{'…' if len(raised) > 4 else ''}.")
                if failed:
                    summary += f" {len(failed)} line(s) could not be raised: {', '.join(failed[:3])}."
                return {"summary": summary, "entity": {"po_numbers": raised, "failed": failed, "value_gbp": value}}
            if t == "resolution":
                # Van stock, pre-8AM miss, carrier delay, arrival risk — all four
                # go through the same entry point a human clicking the option on
                # the map or the card would hit, so approving from the queue and
                # acting from the module produce identical state and identical
                # audit. The queue is a second doorway, not a second code path.
                res = synthetic_state.apply_resolution(p["kind"], p["subject"], p["action"], by)
                if res.get("error"):
                    return {"summary": f"Could not apply: {res['error']}", "entity": res}
                return {"summary": res.get("summary", rec["action"]["label"]), "entity": res}
            if t == "raise_transfer":
                sto = synthetic_state.create_transfer_order(p)
                return {"summary": f"Raised transfer {sto['transfer_id']} — {p.get('quantity')} × {p.get('sku_code')} to {p.get('to_warehouse')}.", "entity": sto}
            if t == "expedite_po":
                po = synthetic_state.expedite_purchase_order(p["po_number"])
                return {"summary": f"Expedited PO {p['po_number']} — delivery pulled forward.", "entity": po}
            if t == "activate_plan":
                exc = synthetic_state.activate_risk_plan(p["exception_code"], by)
                return {"summary": f"Activated response plan for {p['exception_code']}.", "entity": exc}
            if t == "acknowledge":
                exc = synthetic_state.acknowledge_exception(p["exception_code"], by, p.get("notes"))
                return {"summary": f"Acknowledged {p['exception_code']}.", "entity": exc}
            if t == "resolve_exception":
                exc = synthetic_state.resolve_exception(p["exception_code"], by, p.get("root_cause", "Auto-resolved"), p.get("notes"))
                return {"summary": f"Resolved {p['exception_code']}.", "entity": exc}
            if t == "resolve_defect":
                res = synthetic_state.resolve_vehicle_defect(p["registration"], p["defect_id"], by)
                return {"summary": f"Cleared defect on {p['registration']} — vehicle back in service.", "entity": res}
            if t == "create_disposition":
                res = synthetic_state.create_disposition(p)
                return {"summary": f"Raised disposition on {p.get('sku_code')} ({p.get('action')}).", "entity": res}
        except Exception as e:
            return {"summary": f"Action recorded — downstream reported: {e}"}
        return {"summary": rec["action"].get("executes", "Action executed by agent.")}

    # ─────────────────────────────────────────────────────────────────────────
    # Grounded fallback answering.
    #
    # The conversation itself lives in `app.services.atlas_chat` — it needs the
    # whole state, tool calling and a governed action loop, none of which belong
    # in the deterministic engine. What stays here is the answer of last resort:
    # with no LLM key, or when Gemini is unreachable, these two methods still
    # answer the common questions from live state, so the tab is never dead.
    # ─────────────────────────────────────────────────────────────────────────
    def _ask_context(self, state, recs) -> str:
        inv = state.get("inventory_positions", [])
        reds = [i for i in inv if i.get("rag_status") == "R"]
        ambers = [i for i in inv if i.get("rag_status") == "A"]
        worst = min((i for i in inv if (i.get("days_of_supply") or 999) < 900), key=lambda i: i.get("days_of_supply", 999), default=None)
        scs = state.get("supplier_scorecards", [])
        wsc = min((s for s in scs if s.get("otif_score") is not None), key=lambda s: s["otif_score"], default=None)
        fin = [s for s in scs if s.get("financial_health_flag")]
        vor = [v for v in state.get("fleet_vehicles", []) if v.get("vor")]
        low_van = [e for e in state.get("engineer_locations", []) if e.get("van_stock_low")]
        w = state.get("demand_signals", {}).get("weather", {})
        hive = state.get("demand_signals", {}).get("hive_faults", {})
        opens = [e for e in state.get("exceptions", []) if e.get("status") == "open"]
        p1 = [e for e in opens if e.get("priority") == "P1"]
        auto_today = sum(1 for d in self._decisions.values() if d["outcome"] == "auto" and d["at"][:10] == datetime.now(timezone.utc).date().isoformat())
        top = "; ".join(f"{r['agent_name']}: {r['title']}" for r in recs[:3]) or "none"
        return (
            f"Escalated to you: {len(recs)} ({sum(1 for r in recs if r['severity'] in ('critical','high'))} crit/high). Top: {top}.\n"
            f"Auto-executed by the fleet today: {auto_today}.\n"
            f"Inventory: {len(reds)} red, {len(ambers)} amber SKUs" + (f"; lowest cover {worst['sku_code']} {worst.get('days_of_supply')}d." if worst else ".") + "\n"
            f"Suppliers: {len(fin)} financial-health flags" + (f"; worst OTIF {wsc.get('name')} {wsc.get('otif_score')}%." if wsc else ".") + "\n"
            f"Fleet: {len(vor)} vehicles off road; {len(low_van)} engineers low on van stock.\n"
            f"Demand: HDD {w.get('heating_degree_days_7d')}, uplift x{w.get('demand_uplift_factor')}, Hive high-prob {hive.get('high_probability_signals_24h')}/24h.\n"
            f"Exceptions: {len(opens)} open ({len(p1)} P1). Autonomy: {self._fleet_autonomy}; auto-approve under £{self._guardrails['auto_approve_under_gbp']:,}."
        )

    def _deterministic_answer(self, q, state, recs) -> str:
        ql = q.lower()
        ctx = self._ask_context(state, recs).splitlines()
        pick = lambda key: next((l for l in ctx if l.lower().startswith(key)), "")
        if any(k in ql for k in ("auto", "executed", "self")):
            return pick("auto-executed") or "I self-execute routine actions within guardrails."
        if any(k in ql for k in ("approve", "queue", "pending", "escalat", "decision")):
            top = "; ".join(r["title"] for r in recs[:3]) or "nothing"
            return f"{len(recs)} proposals escalated to you. Top: {top}."
        if any(k in ql for k in ("stock", "inventory", "supply", "replenish", "sku")):
            return pick("inventory")
        if any(k in ql for k in ("supplier", "otif", "vendor")):
            return pick("suppliers")
        if any(k in ql for k in ("van", "vehicle", "fleet", "vor", "transport", "route")):
            return pick("fleet")
        if any(k in ql for k in ("weather", "demand", "cold", "hdd", "iot", "boiler", "fault")):
            return pick("demand")
        if any(k in ql for k in ("exception", "p1", "incident", "alert")):
            return pick("exceptions")
        return self._briefing(recs)["headline"]

    # ─────────────────────────────────────────────────────────────────────────
    # Specialist generators (grounded in real snapshot fields)
    # ─────────────────────────────────────────────────────────────────────────
    def _gen_replenishment(self, state) -> list[dict]:
        agent = AGENTS_BY_ID["replenishment"]
        out: list[dict] = []
        items = state.get("inventory_positions", [])
        pos = state.get("purchase_orders", [])
        open_po = {p.get("sku_code"): p for p in pos if p.get("status") in ("draft", "confirmed", "in_transit")}

        # ── Replenishment is the one domain where the backlog is unbounded: a
        # 1,200-SKU catalogue can hold seventy short positions at once. Showing an
        # arbitrary top-N of them would make the queue a rolling window — the count
        # and the value would both understate reality, approving a row would
        # simply reveal the next one, and the queue could never be cleared.
        #
        # So the split is by DECISION, not by row:
        #   · a line at or above the individual-review line is material enough to
        #     be judged on its own merits — its own row, its own trace
        #   · everything below it that escalates for the SAME reason is one
        #     decision about that reason, with every line itemised on the row
        # Approving a grouped row commits every line in it, so the queue always
        # represents the whole backlog and always shrinks when it is worked.
        material = self._guardrails.get("individual_review_over_gbp", 50_000)

        def _line(item, po_type):
            qty = max(item.get("target_order_qty") or 0, item.get("safety_stock_level") or 0)
            if qty <= 0:
                return None
            return {
                "sku_code": item["sku_code"], "description": item.get("description", item["sku_code"]),
                "quantity": qty, "value_gbp": round(qty * (item.get("unit_cost_gbp") or 50)),
                "days_of_supply": item.get("days_of_supply"), "lead_time_days": item.get("lead_time_days"),
                "supplier_code": _SKU_SUPPLIER.get(item["sku_code"], "WOL_UK"),
                "warehouse_code": "LEI_COE", "po_type": po_type,
            }

        def _po_action(line, po_type, tk, label):
            return {"type": "raise_po", "threshold_key": tk, "label": label, "requires_permission": "write:po",
                    "executes": f"Raises a{'n EMERGENCY' if po_type == 'emergency' else ' standard'} PO for "
                                f"{line['quantity']} × {line['sku_code']} on {line['supplier_code']}.",
                    "params": {"sku_code": line["sku_code"], "supplier_code": line["supplier_code"],
                               "warehouse_code": "LEI_COE", "po_type": po_type, "quantity": line["quantity"],
                               "notes": f"Replenishment Agent — {'critical stock' if po_type == 'emergency' else 'amber cover'}."}}

        def _batch_action(lines, po_type, tk, label):
            return {"type": "raise_po_batch", "threshold_key": tk, "label": label, "requires_permission": "write:po",
                    "executes": f"Raises {len(lines)} {po_type} purchase order(s) covering "
                                f"£{sum(l['value_gbp'] for l in lines):,} of stock.",
                    "params": {"lines": lines, "po_type": po_type}}

        for rag, po_type, tk, sev, conf, verb in (
            ("A", "standard", "raise_po_standard", "medium", 78, "Replenish"),
            ("R", "emergency", "raise_po_emergency", "critical", 94, "Emergency PO for"),
        ):
            pool = [i for i in items if i.get("rag_status") == rag and i["sku_code"] not in open_po]
            lines = sorted([l for l in (_line(i, po_type) for i in pool) if l], key=lambda l: -l["value_gbp"])
            if not lines:
                continue
            # Whether the big lines are reviewed individually is decided by the
            # SET, never by rank within it. "Top five by value" would look tidy
            # and be a treadmill: approving the largest simply promotes the next
            # into the slot, so the count never falls. The question is instead
            # whether individual review is meaningful at all here:
            #
            #   a handful above the line  → genuinely exceptional orders; each
            #                               gets its own row and its own argument
            #   a great many above it     → the whole distribution has shifted.
            #                               That is ONE fact about the network, so
            #                               it is one decision. Line-level work on
            #                               it belongs in Demand & Inventory, which
            #                               is built for it; the queue is for
            #                               decisions, not for data entry.
            cap = self._guardrails.get("max_individual_reviews", 5)
            above = [l for l in lines if l["value_gbp"] >= material]
            individually_reviewable = len(above) <= cap
            headline = above if individually_reviewable else []
            spilled = [] if individually_reviewable else above
            routine = [l for l in lines if l["value_gbp"] < material]

            for l in headline:
                dos, lead = l["days_of_supply"] or 0, l["lead_time_days"] or 2
                out.append(self._rec(
                    agent, f"{po_type}:{l['sku_code']}", title=f"{verb} {l['description']}",
                    severity=sev, confidence=conf, value_gbp=l["value_gbp"],
                    summary=(f"{l['sku_code']} holds {dos:g} days of cover against a {lead}-day lead time with no PO in "
                             f"flight. At £{l['value_gbp']:,} this order is above the £{material:,} individual-review line, "
                             f"so it is put to you on its own merits rather than grouped."),
                    evidence=[{"label": "Days of supply", "value": f"{dos:g}d"},
                              {"label": "Lead time", "value": f"{lead}d"},
                              {"label": "Order value", "value": f"£{l['value_gbp']:,}"},
                              {"label": "Supplier", "value": l["supplier_code"]}],
                    projected_impact=[{"label": "Stockout risk", "value": "Removed", "direction": "down"},
                                      {"label": "Expediting cost", "value": "Avoided", "direction": "down"}],
                    action=_po_action(l, po_type, tk, "Approve PO" if po_type == "standard" else "Approve emergency PO")))

            for group, key, why in (
                (spilled, "spill",
                 f"all {len(spilled)} are above the £{material:,} individual-review line — but {len(spilled)} lines "
                 f"crossing it at once is a shifted demand distribution, one fact about the network rather than "
                 f"{len(spilled)} separate judgements. Work individual lines in Demand & Inventory if you need to"),
                (routine, "batch",
                 "each is inside the mandate individually but this action class always escalates"
                 if po_type == "emergency" else
                 f"each sits under the £{material:,} individual-review line"),
            ):
                if not group:
                    continue
                total = sum(l["value_gbp"] for l in group)
                worst = min((l["days_of_supply"] for l in group if l["days_of_supply"] is not None), default=0)
                out.append(self._rec(
                    agent, f"{po_type}:{key}", value_gbp=total, severity=sev, confidence=conf,
                    title=(f"{len(group)} {po_type} replenishment{'s' if len(group) != 1 else ''} "
                           f"— £{total:,} across {len(group)} SKU{'s' if len(group) != 1 else ''}"),
                    summary=(f"{len(group)} position{'s are' if len(group) != 1 else ' is'} short with no PO in flight and "
                             f"{why}. They are one decision, not {len(group)}: same action, same reason, differing only "
                             f"by SKU. Lowest cover in the group is {worst:g} days. Approving commits all "
                             f"{len(group)} order{'s' if len(group) != 1 else ''} — every line is listed below."),
                    evidence=[{"label": "SKUs", "value": len(group)},
                              {"label": "Total value", "value": f"£{total:,}"},
                              {"label": "Largest line", "value": f"£{group[0]['value_gbp']:,}"},
                              {"label": "Lowest cover", "value": f"{worst:g}d"}],
                    projected_impact=[{"label": "Positions covered", "value": len(group), "direction": "up"},
                                      {"label": "Stockout risk", "value": "Removed", "direction": "down"}],
                    action=_batch_action(group, po_type, tk, f"Approve all {len(group)}"),
                    batch={"count": len(group), "total_gbp": total,
                           "max_line_gbp": group[0]["value_gbp"], "lines": group}))

        # Expedite: a red SKU that already HAS an open PO landing too late.
        for item in [i for i in items if i.get("rag_status") == "R" and i["sku_code"] in open_po][:1]:
            po = open_po[item["sku_code"]]
            out.append(self._rec(
                agent, f"exp:{po['po_number']}", title=f"Expedite inbound PO {po['po_number']} — {item['sku_code']} critical",
                severity="high", confidence=80, value_gbp=0,
                summary=(f"{item['sku_code']} is critical ({item.get('days_of_supply'):g}d) and its replenishment {po['po_number']} "
                         f"is still in flight. Expediting pulls the delivery forward to close the exposure sooner."),
                evidence=[{"label": "PO", "value": po["po_number"]}, {"label": "Days of supply", "value": f"{item.get('days_of_supply'):g}d"},
                          {"label": "PO status", "value": po.get("status")}],
                projected_impact=[{"label": "Delivery", "value": "Pulled forward", "direction": "up"}, {"label": "Exposure window", "value": "Shortened", "direction": "down"}],
                action={"type": "expedite_po", "threshold_key": "expedite_po", "label": "Approve expedite", "requires_permission": "write:po",
                        "executes": f"Expedites PO {po['po_number']} to the fastest available delivery.",
                        "params": {"po_number": po["po_number"]}}))

        excess = sorted([i for i in items if i.get("rag_status") == "G" and (i.get("days_of_supply") or 0) > 120],
                        key=lambda i: -((i.get("quantity_available") or 0) * (i.get("unit_cost_gbp") or 50)))
        if excess:
            item = excess[0]
            trapped = round((item.get("quantity_available") or 0) * (item.get("unit_cost_gbp") or 50))
            if trapped >= 5000:
                out.append(self._rec(
                    agent, f"excess:{item['sku_code']}", title=f"Recover working capital from excess {item['sku_code']}",
                    severity="opportunity", confidence=76, value_gbp=0,
                    summary=(f"{item.get('description', item['sku_code'])} carries {item.get('days_of_supply'):g} days of cover — beyond "
                             f"policy. About £{trapped:,} of working capital is trapped. Flag for disposition while cover is ample."),
                    evidence=[{"label": "Days of supply", "value": f"{item.get('days_of_supply'):g}d"}, {"label": "Capital trapped", "value": f"£{trapped:,}"},
                              {"label": "On hand", "value": item.get("quantity_available")}],
                    projected_impact=[{"label": "Working capital", "value": f"+£{round(trapped*0.4):,}", "direction": "up"}, {"label": "Service level", "value": "Unchanged", "direction": "neutral"}],
                    action={"type": "create_disposition", "threshold_key": "create_disposition", "label": "Flag for disposition", "requires_permission": "write:po",
                            "executes": f"Raises an excess disposition on {item['sku_code']} for the inventory analyst.",
                            "params": {"sku_code": item["sku_code"], "action": "rebalance", "units": max(1, round((item.get("quantity_available") or 0) * 0.3)),
                                       "notes": "Replenishment Agent — excess cover beyond policy."}}))
        return out

    def _gen_exceptions(self, state) -> list[dict]:
        agent = AGENTS_BY_ID["exception"]
        out: list[dict] = []
        sla = {"P1": 5, "P2": 30, "P3": 240, "P4": 1440}
        now = datetime.now(timezone.utc)
        for exc in sorted([e for e in state.get("exceptions", []) if e.get("status") == "open"], key=lambda e: e.get("priority", "P4")):
            pr = exc.get("priority", "P3")
            elapsed = 0
            if exc.get("created_at"):
                try:
                    elapsed = round((now - datetime.fromisoformat(exc["created_at"])).total_seconds() / 60)
                except Exception:
                    elapsed = 0
            target = sla.get(pr, 240)
            breaching = elapsed > target * 0.6
            sev = "critical" if pr == "P1" else "high" if pr == "P2" else "medium"
            if exc.get("scenario_id"):
                out.append(self._rec(
                    agent, exc["exception_code"], title=f"Activate response plan: {exc['title']}", severity=sev, confidence=90 if breaching else 82,
                    summary=(f"{exc['exception_code']} ({pr}) has been open {elapsed}m against a {target}m SLA. A researched response "
                             f"playbook is staged. Activating it acknowledges the exception and sets its compensatory actions in motion."),
                    evidence=[{"label": "Priority", "value": pr}, {"label": "SLA", "value": f"{elapsed}m / {target}m", "detail": "breaching" if breaching else "within"},
                              {"label": "Engineers at risk", "value": exc.get("impacted_engineer_count", 0)}, {"label": "Est. resolution", "value": f"{exc.get('estimated_resolution_hours', '—')}h"}],
                    projected_impact=[{"label": "Response plan", "value": "Activated", "direction": "up"}, {"label": "SLA breach", "value": "Averted", "direction": "down"}],
                    action={"type": "activate_plan", "threshold_key": "activate_plan", "label": "Approve & activate plan", "requires_permission": "write:exception",
                            "executes": f"Activates the response plan for {exc['exception_code']} and acknowledges it.", "params": {"exception_code": exc["exception_code"]}}))
            else:
                out.append(self._rec(
                    agent, exc["exception_code"], title=f"Acknowledge & own: {exc['title']}", severity=sev, confidence=80,
                    summary=f"{exc['exception_code']} ({pr}) is open with no owner {elapsed}m in. Acknowledging assigns it and starts the resolution clock.",
                    evidence=[{"label": "Priority", "value": pr}, {"label": "Open for", "value": f"{elapsed}m"}, {"label": "Category", "value": (exc.get("category") or "").replace("_", " ")}],
                    projected_impact=[{"label": "Ownership", "value": "Assigned", "direction": "up"}],
                    action={"type": "acknowledge", "threshold_key": "acknowledge", "label": "Approve acknowledge", "requires_permission": "write:exception",
                            "executes": f"Acknowledges {exc['exception_code']}.", "params": {"exception_code": exc["exception_code"], "notes": "Acknowledged on Exception Response Agent recommendation."}}))
        return out

    def _gen_supplier(self, state) -> list[dict]:
        agent = AGENTS_BY_ID["supplier"]
        out: list[dict] = []
        for sc in state.get("supplier_scorecards", []):
            otif, code, name = sc.get("otif_score"), sc.get("supplier_code"), sc.get("name", sc.get("supplier_code"))
            risk = sc.get("composite_risk_score")
            if sc.get("financial_health_flag"):
                out.append(self._rec(
                    agent, f"fin:{code}", title=f"Financial-health flag: {name}", severity="critical", confidence=88,
                    summary=(f"{name} has raised a financial-health flag. Insolvency is visible months ahead if watched. Open a "
                             f"contingency review and secure in-transit stock and tooling."),
                    evidence=[{"label": "OTIF", "value": f"{otif:g}%" if otif is not None else "—"}, {"label": "Composite risk", "value": risk if risk is not None else "—"},
                              {"label": "Tier-1", "value": "Yes" if sc.get("is_tier1") else "No"}],
                    projected_impact=[{"label": "Exposure", "value": "Quantified", "direction": "down"}, {"label": "Continuity", "value": "Protected", "direction": "up"}],
                    action={"type": "supplier_review", "threshold_key": "supplier_review", "label": "Open contingency review", "requires_permission": "write:supplier_review",
                            "executes": f"Opens a supplier contingency review for {name} and freezes new commitments.", "params": {"supplier_code": code, "kind": "insolvency_review"}}))
            elif otif is not None and otif < 80:
                out.append(self._rec(
                    agent, f"otif:{code}", title=f"OTIF drift: {name} at {otif:g}%", severity="high" if otif < 65 else "medium", confidence=72 + min(20, round(80 - otif)),
                    summary=(f"{name} OTIF has fallen to {otif:g}%, below the 80% review trigger. No supply gap yet, but sustained drift "
                             f"erodes cover winter demand will expose. Place on the watch-list with weekly reporting."),
                    evidence=[{"label": "OTIF", "value": f"{otif:g}%", "detail": "target 92%"}, {"label": "Composite risk", "value": risk if risk is not None else "—"},
                              {"label": "Sedex", "value": (sc.get("sedex_risk_level") or "—").title()}],
                    projected_impact=[{"label": "Monitoring", "value": "Weekly", "direction": "up"}, {"label": "Hidden slippage", "value": "Exposed", "direction": "down"}],
                    action={"type": "otif_watchlist", "threshold_key": "otif_watchlist", "label": "Add to OTIF watch-list", "requires_permission": "write:supplier_review",
                            "executes": f"Adds {name} to the active OTIF watch-list with weekly reporting.", "params": {"supplier_code": code, "kind": "otif_watchlist"}}))
        out.sort(key=lambda r: (SEVERITY_RANK[r["severity"]], -r["confidence"]))
        return out

    def _gen_transport(self, state) -> list[dict]:
        agent = AGENTS_BY_ID["transport"]
        # Late third-party legs and rounds about to miss a booked window, each
        # carrying the fix the option engine recommends for it.
        out: list[dict] = self._resolution_recs(("carrier", "eta"), "transport")
        fleet = state.get("fleet_vehicles", [])
        vor = [v for v in fleet if v.get("vor")]
        if vor:
            v = vor[0]
            major = next((d for d in v.get("defects", []) if d.get("severity") == "major" and d.get("status") == "open"), None) \
                or next((d for d in v.get("defects", []) if d.get("severity") == "major"), None)
            defect_id = (major or {}).get("defect_id")
            out.append(self._rec(
                agent, f"vor:{v['registration']}", title=f"Vehicle off road: {v['registration']} ({v.get('engineer_name')})", severity="high", confidence=85,
                summary=(f"{v['registration']} is off road with an open major defect. {v.get('engineer_name')} in {v.get('region')} loses "
                         f"today's round unless the defect is cleared and cover arranged."),
                evidence=[{"label": "Region", "value": v.get("region")}, {"label": "Defect", "value": (major or {}).get("defect_desc", "Major defect")}, {"label": "Vehicle", "value": v.get("make_model")}],
                projected_impact=[{"label": "VOR time", "value": "Reduced", "direction": "down"}, {"label": "Route coverage", "value": "Restored", "direction": "up"}],
                action={"type": "resolve_defect", "threshold_key": "resolve_defect", "label": "Clear defect & dispatch", "requires_permission": "read:field",
                        "executes": f"Clears the defect on {v['registration']} and returns it to service.", "params": {"registration": v["registration"], "defect_id": defect_id}}))
        missing = [v for v in fleet if not v.get("walkaround_completed") and not v.get("vor")]
        if len(missing) >= 3:
            regs = ", ".join(v["registration"] for v in missing[:3])
            out.append(self._rec(
                agent, "walkaround", title=f"{len(missing)} vehicles missing DVSA walkaround", severity="medium", confidence=78,
                summary=f"{len(missing)} vehicles have no compliant walkaround logged today ({regs}…). Driving without one is a DVSA compliance risk.",
                evidence=[{"label": "Vehicles", "value": len(missing)}, {"label": "Example", "value": regs}],
                projected_impact=[{"label": "DVSA compliance", "value": "Restored", "direction": "up"}],
                action={"type": "agent_task", "threshold_key": "walkaround_reminder", "label": "Push walkaround reminder", "requires_permission": "read:field",
                        "executes": f"Sends a walkaround-due reminder to {len(missing)} drivers.", "params": {"kind": "walkaround_reminder", "count": len(missing)}}))
        low_van = [e for e in state.get("engineer_locations", []) if e.get("van_stock_low")]
        if len(low_van) >= 5:
            out.append(self._rec(
                agent, "vanstock", title=f"{len(low_van)} engineers below van-stock minimum", severity="medium", confidence=74,
                summary=f"{len(low_van)} engineers carry below-minimum van stock. Re-sequencing tonight's run by severity protects the most at-risk jobs.",
                evidence=[{"label": "Engineers low", "value": len(low_van)}],
                projected_impact=[{"label": "First-time-fix", "value": "Protected", "direction": "up"}],
                action={"type": "agent_task", "threshold_key": "resequence_run", "label": "Re-sequence run", "requires_permission": "read:field",
                        "executes": "Re-sequences tonight's van replenishment run by van-stock severity.", "params": {"kind": "resequence_run", "count": len(low_van)}}))
        return out

    def _gen_demand_sensing(self, state) -> list[dict]:
        agent = AGENTS_BY_ID["demand_sensing"]
        out: list[dict] = []
        ds = state.get("demand_signals", {})
        w, hive = ds.get("weather", {}), ds.get("hive_faults", {})
        hdd, uplift = w.get("heating_degree_days_7d") or 0, w.get("demand_uplift_factor") or 1.0
        lockouts, high_sig = hive.get("condensate_lockout_signals_24h") or 0, hive.get("high_probability_signals_24h") or 0
        # What the IoT module already knows about whether we can cover the surge.
        # Recommending a pre-position without this is advice given blind: if cover
        # is already complete the move is noise, and if signals are sitting
        # uncovered it is the most urgent thing on the page.
        estate = synthetic_state.get_iot_estate_health()
        cover_pct, blocked = estate.get("parts_cover_pct"), estate.get("pre_positioning_blocked") or 0
        if hdd >= 90 or uplift >= 1.35:
            out.append(self._rec(
                agent, "weather_surge", title="Cold-snap surge forming — pre-position boiler parts",
                severity="high" if (uplift >= 1.4 or blocked) else "medium",
                confidence=70 + min(25, round((uplift - 1.2) * 60)), value_gbp=30000,
                summary=(f"Heating degree days at {hdd:g} with demand uplift ×{uplift:g}. Boiler-fault demand spikes as transport tightens. "
                         + (f"{blocked} predicted fault{'s' if blocked > 1 else ''} already {'have' if blocked > 1 else 'has'} no part within reach — "
                            f"move stock before the surge lands, not after."
                            if blocked else
                            "Parts cover is complete today; pre-positioning to the coldest hubs protects it as volume climbs.")),
                evidence=[{"label": "Heating degree days", "value": f"{hdd:g}"}, {"label": "Demand uplift", "value": f"×{uplift:g}"},
                          {"label": "Condensate lockouts", "value": f"{lockouts:,}/24h"},
                          {"label": "Parts cover", "value": f"{cover_pct:g}%" if cover_pct is not None else "—"}],
                projected_impact=[{"label": "Surge readiness", "value": "Ahead of demand", "direction": "up"}, {"label": "Expediting cost", "value": "Reduced", "direction": "down"}],
                action={"type": "agent_task", "threshold_key": "pre_position", "label": "Pre-position stock", "requires_permission": "write:po",
                        "executes": "Pre-positions condensate & diverter-valve stock to the coldest-region hubs.", "params": {"kind": "pre_position", "hdd": hdd}}))
        if lockouts >= 300 or high_sig >= 4000:
            out.append(self._rec(
                agent, "proactive_outreach", title="Queue proactive outreach on high-risk boilers", severity="medium", confidence=75,
                summary=(f"Hive telemetry shows {high_sig:,} high-probability fault signals and {lockouts:,} condensate lockouts in 24h. "
                         f"Proactive outreach converts an emergency breakdown into a planned, first-time-fix visit."),
                evidence=[{"label": "High-prob signals", "value": f"{high_sig:,}/24h"}, {"label": "Condensate lockouts", "value": f"{lockouts:,}/24h"}, {"label": "Top fault", "value": hive.get("top_fault_type", "—")}],
                projected_impact=[{"label": "Reactive callouts", "value": "Reduced", "direction": "down"}, {"label": "First-time-fix", "value": "Improved", "direction": "up"}],
                action={"type": "agent_task", "threshold_key": "proactive_outreach", "label": "Queue outreach", "requires_permission": "read:field",
                        "executes": "Queues proactive outreach to the highest-risk Hive-flagged properties.", "params": {"kind": "proactive_outreach", "signals": high_sig}}))
        return out

    def _gen_visibility(self, state) -> list[dict]:
        agent = AGENTS_BY_ID["visibility"]
        # Van-stock shortages and pre-8AM misses, each with its recommended fix.
        out: list[dict] = self._resolution_recs(("van", "locker"), "visibility")
        lockers = state.get("locker_status", [])
        alerting = [l for l in lockers if l.get("status") == "alert"]
        no_pre8 = [l for l in alerting if not l.get("pre_8am_delivered")]
        if len(no_pre8) >= 4:
            regions = {}
            for l in no_pre8:
                regions[l.get("region")] = regions.get(l.get("region"), 0) + 1
            worst_region = max(regions, key=regions.get)
            out.append(self._rec(
                agent, "locker_failover", title=f"{len(no_pre8)} lockers missed pre-8AM — fail over to healthy sites",
                severity="high" if len(no_pre8) >= 10 else "medium", confidence=80,
                summary=(f"{len(no_pre8)} ByBox sites missed their pre-8AM delivery ({regions.get(worst_region)} in {worst_region}). "
                         f"Engineers will arrive to unconfirmed stock. Failing over to the nearest healthy sites keeps them working."),
                evidence=[{"label": "Sites missed", "value": len(no_pre8)}, {"label": "Worst region", "value": worst_region}, {"label": "Alerting total", "value": len(alerting)}],
                projected_impact=[{"label": "Pre-8AM success", "value": "Recovered", "direction": "up"}, {"label": "Engineer idle time", "value": "Reduced", "direction": "down"}],
                action={"type": "agent_task", "threshold_key": "locker_failover", "label": "Fail over lockers", "requires_permission": "read:field",
                        "executes": f"Fails {len(no_pre8)} offline lockers over to their nearest healthy sites and notifies affected engineers.",
                        "params": {"kind": "locker_failover", "count": len(no_pre8), "region": worst_region}}))
        shipments = state.get("shipments", [])
        delayed = sorted([s for s in shipments if (s.get("delay_hours") or 0) >= 4], key=lambda s: -(s.get("delay_hours") or 0))
        if delayed:
            s = delayed[0]
            out.append(self._rec(
                agent, f"ship:{s['shipment_ref']}", title=f"Inbound {s['shipment_ref']} delayed {s.get('delay_hours'):g}h — reroute cover",
                severity="high" if (s.get("delay_hours") or 0) >= 8 else "medium", confidence=76,
                summary=(f"{s['shipment_ref']} from {s.get('supplier_name')} into {s.get('destination_warehouse')} is running "
                         f"{s.get('delay_hours'):g}h late ({s.get('status')}). Reroute cover stock from the nearest hub for jobs booked against it."),
                evidence=[{"label": "Delay", "value": f"{s.get('delay_hours'):g}h"}, {"label": "Carrier", "value": s.get("carrier")}, {"label": "Destination", "value": s.get("destination_warehouse")}],
                projected_impact=[{"label": "Affected jobs", "value": "Covered", "direction": "up"}, {"label": "Failed first visits", "value": "Avoided", "direction": "down"}],
                action={"type": "agent_task", "threshold_key": "reroute_inbound", "label": "Reroute cover stock", "requires_permission": "read:field",
                        "executes": f"Reroutes cover stock from the nearest hub for jobs booked against {s['shipment_ref']}.",
                        "params": {"kind": "reroute_inbound", "shipment_ref": s["shipment_ref"]}}))
        return out

    def _gen_sustainability(self, state) -> list[dict]:
        agent = AGENTS_BY_ID["sustainability"]
        out: list[dict] = []
        # reverse_pipeline is a staged funnel (dict), not a list of units — read the
        # backlog off the stages that have not yet been collected.
        rev = synthetic_state.reverse_collection_backlog()
        pending, at_risk = rev["pending"], rev["at_risk"]
        if pending >= 8:
            out.append(self._rec(
                agent, "collection_sweep", title=f"{pending} decommissioned units awaiting collection", severity="medium" if pending < 200 else "high", confidence=76,
                summary=(f"{pending} old boilers/heat pumps await reverse-logistics collection. Left to age they risk WEEE "
                         f"non-compliance and tie up boot space. A consolidated sweep clears the backlog and cuts empty-mile Scope 3."),
                evidence=[{"label": "Awaiting collection", "value": pending},
                          {"label": "WEEE compliance", "value": f"{rev['weee_compliant_pct']:g}%"},
                          {"label": "WEEE at risk", "value": at_risk}],
                projected_impact=[{"label": "WEEE compliance", "value": "Protected", "direction": "up"}, {"label": "Scope 3 (empty miles)", "value": "Reduced", "direction": "down"}],
                action={"type": "agent_task", "threshold_key": "collection_sweep", "label": "Schedule collection sweep", "requires_permission": "read:reverse",
                        "executes": f"Schedules a consolidated collection sweep for {pending} pending units.", "params": {"kind": "collection_sweep", "count": pending}}))
        return out

    # ── no-code watch rules ──────────────────────────────────────────────────
    def _metric_value(self, metric, state):
        inv = state.get("inventory_positions", [])
        if metric == "min_days_of_supply":
            vals = [(i.get("days_of_supply"), i.get("sku_code")) for i in inv if (i.get("days_of_supply") or 999) < 900]
            if not vals:
                return None, "—"
            v, sku = min(vals, key=lambda t: t[0]); return round(v, 1), sku
        if metric == "amber_red_sku_count":
            return sum(1 for i in inv if i.get("rag_status") in ("A", "R")), "network"
        if metric == "min_supplier_otif":
            scs = [s for s in state.get("supplier_scorecards", []) if s.get("otif_score") is not None]
            if not scs:
                return None, "—"
            s = min(scs, key=lambda x: x["otif_score"]); return round(s["otif_score"], 1), s.get("name", s.get("supplier_code"))
        if metric == "open_exception_count":
            return sum(1 for e in state.get("exceptions", []) if e.get("status") == "open"), "network"
        if metric == "vor_count":
            return sum(1 for v in state.get("fleet_vehicles", []) if v.get("vor")), "fleet"
        if metric == "min_throughput_pct":
            whs = [w for w in state.get("warehouse_status", []) if w.get("throughput_vs_baseline_pct") is not None]
            if not whs:
                return None, "—"
            w = min(whs, key=lambda x: x["throughput_vs_baseline_pct"]); return round(w["throughput_vs_baseline_pct"], 1), w.get("code")
        if metric == "demand_uplift":
            return round(state.get("demand_signals", {}).get("weather", {}).get("demand_uplift_factor", 1.0), 2), "network"
        return None, "—"

    @staticmethod
    def _cmp(val, op, threshold) -> bool:
        if val is None:
            return False
        return {"<": val < threshold, "<=": val <= threshold, ">": val > threshold, ">=": val >= threshold, "==": val == threshold}.get(op, False)

    def _gen_custom(self, state) -> list[dict]:
        out = []
        for rule in self._custom_rules:
            val, ctx = self._metric_value(rule["metric"], state)
            if not self._cmp(val, rule["operator"], rule["threshold"]):
                continue
            meta = CUSTOM_METRICS[rule["metric"]]
            unit = meta["unit"]
            out.append(self._rec(
                CUSTOM_AGENT, rule["id"], title=rule["name"], severity=rule["severity"], confidence=99, value_gbp=0,
                summary=(f"Your watch rule fired: {meta['label']} is {val}{unit} ({rule['operator']} {rule['threshold']:g}{unit} "
                         f"threshold) at {ctx}. Acknowledge to log the breach and notify the domain owner."),
                evidence=[{"label": meta["label"], "value": f"{val}{unit}"}, {"label": "Threshold", "value": f"{rule['operator']} {rule['threshold']:g}{unit}"}, {"label": "Where", "value": ctx}],
                projected_impact=[{"label": "Breach", "value": "Logged & notified", "direction": "up"}],
                action={"type": "agent_task", "threshold_key": "custom_rule_ack", "label": "Acknowledge breach", "requires_permission": "read:field",
                        "executes": f"Logs the '{rule['name']}' breach and notifies the domain owner.", "params": {"rule_id": rule["id"], "kind": "custom_rule_ack"}}))
        return out


def get_llm_model() -> str:
    from app.config import get_settings
    return get_settings().llm_model


agent_engine = AgentEngine()


async def flush_agent_state() -> None:
    """Drain any debounced write. Called from the app's shutdown path so an
    approval made in the last second before exit still reaches disk."""
    await _writer.flush_now()
