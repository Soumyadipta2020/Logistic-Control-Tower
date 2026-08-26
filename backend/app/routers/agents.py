"""
Agentic AI layer API.

Exposes the specialist agent fleet, their live recommendation queue, the
human-in-the-loop approval actions, the activity/audit feed, and the autonomy
governance controls. Approving a recommendation executes the real underlying
mutation and (where it changes shared state) broadcasts so every open tab
refetches — the same pattern the exceptions router uses.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel

from app.services.response import ok
from app.services.agent_engine import agent_engine, ORCH
from app.services.atlas_chat import atlas_chat
from app.services import chat_history, llm, speech
from app.services.websocket_manager import ws_manager
from app.synthetic.state import synthetic_state
from app.auth.rbac import get_current_user, require_any_permission, satisfies

router = APIRouter(prefix="/api/v1/agents", tags=["agents"])

# Any of these write-capable permissions may operate the approval queue; the
# per-recommendation permission is enforced individually on approve.
_ACTIONABLE = (
    "write:po", "write:exception", "write:transfer",
    "write:supplier_review", "write:locker", "read:field", "read:reverse",
)


@router.get("")
async def get_fleet(_: dict = Depends(get_current_user)):
    """The agent roster with live per-agent status, fleet metrics, governance
    settings and the orchestrator's daily briefing."""
    return ok(agent_engine.fleet())


@router.get("/recommendations")
async def get_recommendations(
    agent_id: str | None = Query(None),
    _: dict = Depends(get_current_user),
):
    """The current approval queue, grounded in live state, most-severe first."""
    return ok(agent_engine.recommendations(agent_id))


@router.get("/activity")
async def get_activity(limit: int = Query(40, ge=1, le=200), _: dict = Depends(get_current_user)):
    return ok(agent_engine.activity(limit))


@router.get("/actions-today")
async def get_actions_today(_: dict = Depends(get_current_user)):
    """What has actually been done today, grouped by module and by section.

    Every module that lets ATLAS act autonomously renders this on the section
    that owns those actions. It answers the one question live state cannot: a
    screen that is healthy because ATLAS worked all morning looks exactly like a
    screen that is healthy because nothing happened. Only the audit trail knows
    the difference, so the counter and the Audit Log read the same feed.
    """
    return ok(agent_engine.actions_today())


@router.get("/governance")
async def get_governance(_: dict = Depends(get_current_user)):
    """The full action catalog: every action a user can perform across every
    module, sub-module and tab, what ATLAS may do with it autonomously, and the
    exact condition under which it must come to a human instead."""
    from app.synthetic.actions import (
        ACTION_CATALOG, MODULES, AUTONOMY_CLASSES, CATEGORIES, catalog_summary,
    )
    return ok({
        "actions": ACTION_CATALOG, "summary": catalog_summary(),
        "modules": MODULES, "autonomy_classes": AUTONOMY_CLASSES, "categories": CATEGORIES,
        "guardrails": agent_engine._guardrails, "ai_mode": synthetic_state.ai_mode,
    })


@router.get("/state-variation")
async def get_state_variation(_: dict = Depends(get_current_user)):
    """The AI-ON / AI-OFF variation of whatever state the network is in: what
    ATLAS executed autonomously, what it escalated, and the health it moved the
    network from and to. Each entry carries its own reasoning trace."""
    return ok(synthetic_state.ai_response())


class AiModeRequest(BaseModel):
    enabled: bool


@router.put("/mode")
async def set_ai_mode(
    req: AiModeRequest,
    user: dict = Depends(require_any_permission(*_ACTIONABLE)),
):
    """Flip the master switch. The current state is re-applied through the other
    variation, so every module reflects the change immediately."""
    by = user.get("sub") or user.get("name") or "operator"
    result = agent_engine.set_ai_mode(req.enabled, by)
    await _broadcast_after_action()
    return ok(result)


async def _broadcast_after_action():
    """Mirror the exceptions router: push throughput + open-P1 so Visibility and
    the P1 banner reflect an agent-executed action immediately."""
    try:
        snap = synthetic_state.get_snapshot()
        await ws_manager.broadcast("visibility", "throughput", snap.get("warehouse_status", []))
        open_p1 = [e for e in snap.get("exceptions", [])
                   if e.get("priority") == "P1" and e.get("status") == "open"]
        await ws_manager.broadcast("exceptions", "p1_active", open_p1)
        await ws_manager.broadcast("exceptions", "status_change", {"source": "agent"})
    except Exception:
        pass


@router.post("/recommendations/{rec_id}/approve")
async def approve_recommendation(
    rec_id: str,
    user: dict = Depends(require_any_permission(*_ACTIONABLE)),
):
    rec = agent_engine._find(rec_id)
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="Recommendation is no longer applicable.")
    # Enforce the specific permission this recommendation's action requires.
    needed = rec.get("action", {}).get("requires_permission")
    if needed and not satisfies(user.get("permissions", []), needed):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=f"Approving this action requires '{needed}'.")
    by = user.get("sub") or user.get("name") or "operator"
    result = agent_engine.approve(rec_id, by)
    if not result.get("ok"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail=result.get("error", "Could not execute."))
    await _broadcast_after_action()
    return ok(result)


class DismissRequest(BaseModel):
    reason: str | None = None


@router.post("/recommendations/{rec_id}/dismiss")
async def dismiss_recommendation(
    rec_id: str,
    req: DismissRequest,
    user: dict = Depends(require_any_permission(*_ACTIONABLE)),
):
    by = user.get("sub") or user.get("name") or "operator"
    return ok(agent_engine.dismiss(rec_id, by, req.reason))


class AskTurn(BaseModel):
    role: str          # user | model
    text: str


class AskRequest(BaseModel):
    question: str
    history: list[AskTurn] | None = None
    conversation_id: str | None = None


@router.post("/ask")
async def ask_fleet(req: AskRequest, user: dict = Depends(get_current_user)):
    """Ask ATLAS: a grounded conversation over the WHOLE live state, with hands.

    Gemini answers against a digest of every domain and can read further into raw
    state; when the operator asks for something done, it calls a real action. The
    action catalogue then decides what happens — routine in-guardrail actions
    execute inside the turn, anything high-stakes comes back as a proposal for
    this human to approve. With no LLM key it degrades to deterministic answers.
    """
    q = (req.question or "").strip()
    if not q:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Question is empty.")
    history = [t.dict() for t in (req.history or [])]
    result = await atlas_chat.ask(q, history, user)
    # The conversation is kept server-side so it survives the tab, and so the
    # record of what was asked during an incident outlives the incident.
    try:
        header = await chat_history.append_turn(user, req.conversation_id, q, result)
        result = {**result, **header}
    except Exception:
        pass   # history is a convenience; never fail an answer over it
    if result.get("executed"):
        await _broadcast_after_action()
    return ok(result)


@router.get("/models")
async def list_models(_: dict = Depends(get_current_user)):
    """The reasoning models an operator may switch ATLAS between — only those a
    configured key can actually reach, grouped by the provider serving them."""
    return ok({"models": llm.model_catalog(), "active": llm.current_model(),
               "enabled": llm.llm_available(),
               "provider": llm.current_provider() if llm.llm_available() else None,
               "providers": [{"id": p, "label": label, "configured": llm.provider_ready(p)}
                             for p, label in llm.PROVIDER_LABELS.items()]})


class ModelRequest(BaseModel):
    # `model_` is a protected namespace in pydantic v2; the field is named for the
    # domain, not the library, so the namespace is opened rather than the name bent.
    model_config = {"protected_namespaces": ()}
    model_id: str


@router.put("/model")
async def set_model(req: ModelRequest, user: dict = Depends(require_any_permission(*_ACTIONABLE))):
    """Switch the model ATLAS reasons with. Takes effect on the next question and
    is remembered across restarts."""
    try:
        chosen = await llm.set_active_model(req.model_id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    agent_engine._log(
        ORCH, kind="governance",
        title=f"Reasoning model switched to {chosen['label']}",
        detail=f"ATLAS now reasons with {chosen['id']}.",
        by=user.get("sub") or user.get("name") or "operator")
    agent_engine._save()
    return ok({"models": llm.model_catalog(), "active": chosen})


class TranscribeRequest(BaseModel):
    audio: str                      # base64, no data: prefix
    mime_type: str = "audio/wav"


@router.post("/ask/transcribe")
async def transcribe_question(req: TranscribeRequest, _: dict = Depends(get_current_user)):
    """Spoken question → text. The text then goes through the ordinary /ask
    pipeline, so speaking a question and typing it are the same request."""
    if req.mime_type not in llm.AUDIO_MIME:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"Unsupported audio format '{req.mime_type}'.")
    # Whether there is speech at all is settled before the model is consulted —
    # asked to transcribe silence it invents a plausible instruction, and this
    # transcript goes to a pipeline that can act.
    try:
        import base64 as _b64
        raw = _b64.b64decode(req.audio, validate=False)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Audio could not be decoded.")
    if llm.audio_has_speech(raw) is False:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="I didn't hear anything — hold the mic button while you speak, or type it.")
    text = await llm.transcribe(req.audio, req.mime_type)
    if not text:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="I could not make out any speech there — try again, or type it.")
    return ok({"text": text})


class SpeakRequest(BaseModel):
    text: str                                   # the answer, as markdown
    executed: list[dict] | None = None
    proposals: list[dict] | None = None
    voice: str = llm.DEFAULT_VOICE


@router.post("/ask/speak")
async def speak_answer(req: SpeakRequest, _: dict = Depends(get_current_user)):
    """Read an answer aloud. The answer on screen is unchanged — this returns a
    version rewritten for the ear (markup stripped, figures and codes expanded,
    tables left on screen) plus what the turn actually did."""
    spoken = speech.to_speech(req.text)
    tail = speech.spoken_actions(req.executed or [], req.proposals or [])
    if tail:
        spoken = f"{spoken} {tail}".strip()
    if not spoken:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Nothing to read.")
    wav = await llm.synthesize(spoken, req.voice)
    if not wav:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="The voice service did not respond — the answer is on screen.")
    return Response(content=wav, media_type="audio/wav",
                    headers={"Cache-Control": "no-store", "X-Spoken-Chars": str(len(spoken))})


@router.get("/ask/conversations")
async def list_conversations(limit: int = Query(30, ge=1, le=50), user: dict = Depends(get_current_user)):
    """This operator's recent ATLAS conversations, most recent first."""
    return ok({"conversations": await chat_history.list_conversations(user, limit)})


@router.get("/ask/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, user: dict = Depends(get_current_user)):
    """One conversation, rendered exactly as it was — including the actions it
    took. Any approval card in it is reconciled against the live ledger first, so
    a reopened thread shows what became of the decision rather than offering a
    button that can no longer be pressed."""
    conv = await chat_history.get_conversation(user, conversation_id)
    if not conv:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")
    return ok({**conv, "proposal_states": await atlas_chat.proposal_states(conv)})


@router.delete("/ask/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str, user: dict = Depends(get_current_user)):
    return ok({"deleted": await chat_history.delete_conversation(user, conversation_id)})


@router.delete("/ask/conversations")
async def clear_conversations(user: dict = Depends(get_current_user)):
    return ok({"cleared": await chat_history.clear_all(user)})


class ProposalDecision(BaseModel):
    decision: str                  # approve | decline
    reason: str | None = None


@router.post("/ask/proposals/{proposal_id}")
async def decide_proposal(
    proposal_id: str,
    req: ProposalDecision,
    user: dict = Depends(require_any_permission(*_ACTIONABLE)),
):
    """Approve (or decline) an action ATLAS prepared in the chat but is not
    permitted to run unaided. Approving executes the real mutation — the same
    entry point the module and the approvals queue use."""
    if req.decision not in ("approve", "decline"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="decision must be 'approve' or 'decline'.")
    result = await atlas_chat.execute_proposal(proposal_id, user, req.decision, req.reason)
    if not result.get("ok"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail=result.get("error", "Could not execute."))
    if req.decision == "approve":
        await _broadcast_after_action()
    return ok(result)


class GuardrailsRequest(BaseModel):
    auto_approve_under_gbp: int | None = None
    spend_ceiling_gbp: int | None = None
    requires_dual_control_over_gbp: int | None = None


@router.put("/guardrails")
async def update_guardrails(
    req: GuardrailsRequest,
    _: dict = Depends(require_any_permission(*_ACTIONABLE)),
):
    return ok(agent_engine.set_guardrails(req.dict(exclude_none=True)))


class RuleRequest(BaseModel):
    name: str | None = None
    metric: str
    operator: str
    threshold: float
    severity: str | None = "medium"


@router.post("/rules")
async def create_rule(
    req: RuleRequest,
    user: dict = Depends(require_any_permission(*_ACTIONABLE)),
):
    try:
        data = req.dict(exclude_none=True)
        data["created_by"] = user.get("sub") or user.get("name") or "operator"
        return ok(agent_engine.add_rule(data))
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/rules/{rule_id}")
async def delete_rule(rule_id: str, _: dict = Depends(require_any_permission(*_ACTIONABLE))):
    return ok(agent_engine.delete_rule(rule_id))


class AutonomyRequest(BaseModel):
    level: str  # manual | semi | auto


@router.put("/{agent_id}/autonomy")
async def set_autonomy(
    agent_id: str,
    req: AutonomyRequest,
    user: dict = Depends(require_any_permission(*_ACTIONABLE)),
):
    try:
        return ok(agent_engine.set_autonomy(agent_id, req.level))
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
