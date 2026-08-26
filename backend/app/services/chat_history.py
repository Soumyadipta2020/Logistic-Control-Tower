"""
Ask ATLAS conversation history, in Redis.

A control-tower conversation is a work artefact, not chatter: it records what an
operator asked during an incident, what ATLAS found in live state at the time,
and which actions were taken or approved off the back of it. Losing that on a tab
close throws away the audit-adjacent half of the feature — so the thread lives
server-side, per user, and comes back exactly as it was rendered.

Storage is two keys per user:

    atlas:chat:<user>:index          sorted set  cid -> last-updated epoch
    atlas:chat:<user>:conv:<cid>     string      the conversation as JSON

The sorted set gives recency ordering and trimming for free, and each
conversation is a single blob because it is only ever read or written whole.

Redis is optional everywhere else in this app, so it is optional here too: with
no REDIS_URL the same interface is served from an in-process dict. History then
lives as long as the server does, which is the honest degradation — the feature
works, it just stops outliving a restart.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from app.redis_client import get_redis

logger = logging.getLogger("clt.atlas.history")

MAX_CONVERSATIONS = 40        # per user; the oldest fall off the index
MAX_MESSAGES = 80             # per conversation
TTL_SECONDS = 60 * 60 * 24 * 30
_TITLE_LEN = 68

# Used only when Redis is absent. Same shape as the Redis blob.
_memory: dict[str, dict[str, dict]] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uid(user: dict) -> str:
    return str(user.get("sub") or user.get("name") or "operator")


def _index_key(u: str) -> str:
    return f"atlas:chat:{u}:index"


def _conv_key(u: str, cid: str) -> str:
    return f"atlas:chat:{u}:conv:{cid}"


async def _client():
    """The live Redis client, or None when we are running without one."""
    try:
        r = await get_redis()
    except Exception:
        return None
    return r if hasattr(r, "zadd") else None


def _title_from(text: str) -> str:
    t = " ".join((text or "").split())
    return (t[:_TITLE_LEN].rstrip() + "…") if len(t) > _TITLE_LEN else (t or "New conversation")


def _summarise(conv: dict) -> dict:
    """The row the history rail renders — never the whole transcript."""
    msgs = conv.get("messages", [])
    last = next((m for m in reversed(msgs) if m.get("role") == "atlas"), None)
    return {
        "id": conv["id"],
        "title": conv.get("title") or "New conversation",
        "created_at": conv.get("created_at"),
        "updated_at": conv.get("updated_at"),
        "message_count": len(msgs),
        "preview": " ".join((last or {}).get("text", "").split())[:110],
        # What the conversation actually did, so the list reads as a record of
        # work rather than a list of questions.
        "actions": sum(len(m.get("executed") or []) for m in msgs),
        "proposals": sum(len(m.get("proposals") or []) for m in msgs),
    }


# ── read ─────────────────────────────────────────────────────────────────────

async def list_conversations(user: dict, limit: int = 30) -> list[dict]:
    u = _uid(user)
    r = await _client()
    if r is None:
        convs = sorted(_memory.get(u, {}).values(), key=lambda c: c.get("updated_at") or "", reverse=True)
        return [_summarise(c) for c in convs[:limit]]
    try:
        cids = await r.zrevrange(_index_key(u), 0, limit - 1)
        if not cids:
            return []
        blobs = await r.mget([_conv_key(u, c) for c in cids])
        out = []
        for cid, blob in zip(cids, blobs):
            if not blob:
                await r.zrem(_index_key(u), cid)   # index entry outlived its blob
                continue
            try:
                out.append(_summarise(json.loads(blob)))
            except Exception:
                continue
        return out
    except Exception as e:
        logger.warning("Chat history list failed: %s", type(e).__name__)
        return []


async def get_conversation(user: dict, cid: str) -> dict | None:
    u = _uid(user)
    r = await _client()
    if r is None:
        return _memory.get(u, {}).get(cid)
    try:
        blob = await r.get(_conv_key(u, cid))
        return json.loads(blob) if blob else None
    except Exception as e:
        logger.warning("Chat history read failed: %s", type(e).__name__)
        return None


# ── write ────────────────────────────────────────────────────────────────────

async def append_turn(user: dict, cid: str | None, question: str, reply: dict) -> dict:
    """Record one exchange and return the conversation header.

    The assistant turn is stored with everything it was rendered with — steps,
    executed actions, proposals — so a reopened conversation shows what actually
    happened, not a flattened transcript of the prose.
    """
    u = _uid(user)
    conv = (await get_conversation(user, cid)) if cid else None
    if conv is None:
        cid = cid or uuid.uuid4().hex[:12]
        conv = {"id": cid, "title": _title_from(question), "created_at": _now(), "messages": []}

    conv["messages"].append({"role": "user", "text": question, "at": _now()})
    conv["messages"].append({
        "role": "atlas", "text": reply.get("answer", ""), "at": reply.get("at") or _now(),
        "source": reply.get("source"), "model": reply.get("model"),
        "steps": reply.get("steps") or [], "executed": reply.get("executed") or [],
        "proposals": reply.get("proposals") or [], "suggestions": reply.get("suggestions") or [],
    })
    del conv["messages"][:-MAX_MESSAGES]
    conv["updated_at"] = _now()

    await _persist(u, conv)
    return {"conversation_id": conv["id"], "title": conv["title"], "updated_at": conv["updated_at"]}


async def _persist(u: str, conv: dict) -> None:
    r = await _client()
    if r is None:
        store = _memory.setdefault(u, {})
        store[conv["id"]] = conv
        for cid in sorted(store, key=lambda c: store[c].get("updated_at") or "")[:-MAX_CONVERSATIONS]:
            store.pop(cid, None)
        return
    try:
        score = datetime.now(timezone.utc).timestamp()
        await r.set(_conv_key(u, conv["id"]), json.dumps(conv), ex=TTL_SECONDS)
        await r.zadd(_index_key(u), {conv["id"]: score})
        await r.expire(_index_key(u), TTL_SECONDS)
        # Trim the tail: drop the oldest ids beyond the cap, and their blobs.
        stale = await r.zrevrange(_index_key(u), MAX_CONVERSATIONS, -1)
        if stale:
            await r.zrem(_index_key(u), *stale)
            await r.delete(*[_conv_key(u, c) for c in stale])
    except Exception as e:
        logger.warning("Chat history write failed: %s", type(e).__name__)


# ── delete ───────────────────────────────────────────────────────────────────

async def delete_conversation(user: dict, cid: str) -> bool:
    u = _uid(user)
    r = await _client()
    if r is None:
        return _memory.get(u, {}).pop(cid, None) is not None
    try:
        removed = await r.delete(_conv_key(u, cid))
        await r.zrem(_index_key(u), cid)
        return bool(removed)
    except Exception as e:
        logger.warning("Chat history delete failed: %s", type(e).__name__)
        return False


async def clear_all(user: dict) -> int:
    u = _uid(user)
    r = await _client()
    if r is None:
        n = len(_memory.get(u, {}))
        _memory[u] = {}
        return n
    try:
        cids = await r.zrange(_index_key(u), 0, -1)
        if cids:
            await r.delete(*[_conv_key(u, c) for c in cids])
        await r.delete(_index_key(u))
        return len(cids)
    except Exception as e:
        logger.warning("Chat history clear failed: %s", type(e).__name__)
        return 0


# ── pending approvals ────────────────────────────────────────────────────────
# An approval card asks a human to come back and press it. Holding those in
# process memory means every restart — and in development, every hot reload —
# silently voids every card in every open chat, and the operator only finds out
# when the button fails. They belong in the same durable store as the
# conversation that contains them.

PROPOSAL_TTL = 60 * 60 * 24
_proposal_memory: dict[str, dict] = {}


def _prop_key(pid: str) -> str:
    return f"atlas:proposal:{pid}"


async def save_proposal(prop: dict) -> None:
    r = await _client()
    if r is None:
        _proposal_memory[prop["id"]] = prop
        return
    try:
        await r.set(_prop_key(prop["id"]), json.dumps(prop), ex=PROPOSAL_TTL)
    except Exception as e:
        logger.warning("Proposal save failed: %s", type(e).__name__)
        _proposal_memory[prop["id"]] = prop


async def get_proposal(pid: str) -> dict | None:
    r = await _client()
    if r is None:
        return _proposal_memory.get(pid)
    try:
        blob = await r.get(_prop_key(pid))
        return json.loads(blob) if blob else _proposal_memory.get(pid)
    except Exception as e:
        logger.warning("Proposal read failed: %s", type(e).__name__)
        return _proposal_memory.get(pid)
