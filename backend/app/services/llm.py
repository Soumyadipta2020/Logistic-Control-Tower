"""
Thin async client for the reasoning/chat layer behind the agent fleet. Two ways
out to a model, and the operator's choice of model decides which is used:

* **Google AI Studio** (`GOOGLE_API_KEY`) — Gemini, called natively.
* **OpenRouter** (`OPENROUTER_API_KEY`) — one key for Claude, GPT, Grok, Gemini,
  DeepSeek, Qwen and the rest.

Everything above this module speaks Gemini's shapes (`contents`/`parts`,
`functionDeclarations`), because that is what it was written against and those
shapes carry the tool call faithfully. OpenRouter's OpenAI-style
messages/tool_calls are translated at this boundary in both directions, so a
caller never learns which provider answered.

Deliberately minimal and token-frugal:

* `generate()` — one shot, for a single grounded answer.
* `converse()` — multi-turn WITH function calling, so ATLAS can read further
  into live state and propose/execute real actions mid-answer. The caller owns
  the loop (run the tool, append the result, call again); this module only knows
  how to make one request and read one response.
* returns None on ANY failure (missing key, network, bad model id, quota) so the
  caller can fall back to deterministic reasoning — the app never hard-depends on
  the LLM being reachable.
"""

import json
import logging
import httpx

from app.config import get_settings

logger = logging.getLogger("clt.llm")

_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_OR_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
_OR_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech"
_OR_TRANSCRIBE_URL = "https://openrouter.ai/api/v1/audio/transcriptions"

GOOGLE = "google"
OPENROUTER = "openrouter"
PROVIDER_LABELS = {GOOGLE: "Google AI Studio", OPENROUTER: "OpenRouter"}

# ── The models an operator may choose between ────────────────────────────────
# Order is the order they appear in the picker. `id` is what the API is called
# with and `label` is what the operator reads — they differ where a model is
# served under a preview id, which is a deployment detail the operator should
# not have to know or type. A model is only offered if its provider's key is
# set, so the list an operator sees is the list that will actually answer.

GOOGLE_MODELS: list[dict] = [
    {"id": "gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash Lite",
     "blurb": "Fast and cheap. The default for grounded Q&A over live state."},
    {"id": "gemini-3.1-flash-lite", "label": "Gemini 3.1 Flash Lite",
     "blurb": "Previous-generation lite model. Lowest latency."},
    {"id": "gemini-3-flash-preview", "label": "Gemini 3 Flash",
     "blurb": "Full Gemini 3 Flash reasoning, served as a preview build."},
    {"id": "gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash Lite",
     "blurb": "Older lite model. Useful as a baseline for comparison."},
    {"id": "gemini-3.6-flash", "label": "Gemini 3.6 Flash",
     "blurb": "Newest full Flash model. Strongest multi-step tool use."},
    {"id": "gemini-3.5-flash", "label": "Gemini 3.5 Flash",
     "blurb": "Full Flash reasoning — better on long, multi-part questions."},
]

# Every entry here is verified tool-capable on OpenRouter — a model that cannot
# call functions would answer politely and never touch live state, which in this
# panel reads as the agent silently refusing to work. Spread deliberately across
# price and vendor: something to reason hard with, something to run all day, and
# one free model so the tower demonstrates end-to-end with no billing set up.
OPENROUTER_MODELS: list[dict] = [
    {"id": "anthropic/claude-sonnet-5", "label": "Claude Sonnet 5",
     "blurb": "Anthropic · the balanced default. Excellent multi-step tool use."},
    {"id": "anthropic/claude-opus-5", "label": "Claude Opus 5",
     "blurb": "Anthropic · deepest reasoning, for gnarly multi-part incidents."},
    {"id": "anthropic/claude-haiku-4.5", "label": "Claude Haiku 4.5",
     "blurb": "Anthropic · quick and inexpensive for routine questions."},
    {"id": "openai/gpt-5.6-terra", "label": "GPT-5.6 Terra",
     "blurb": "OpenAI · strong general reasoning at a working-day price."},
    {"id": "openai/gpt-5.6-sol", "label": "GPT-5.6 Sol",
     "blurb": "OpenAI · the heavyweight tier. Slower, most thorough."},
    {"id": "openai/gpt-5.4-mini", "label": "GPT-5.4 Mini",
     "blurb": "OpenAI · low latency, low cost, still calls tools reliably."},
    {"id": "google/gemini-3.6-flash", "label": "Gemini 3.6 Flash",
     "blurb": "Google via OpenRouter · same model, billed through one key."},
    {"id": "google/gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash Lite",
     "blurb": "Google via OpenRouter · the cheap default, one key."},
    {"id": "x-ai/grok-4.5", "label": "Grok 4.5",
     "blurb": "xAI · fast reasoning with a very large context window."},
    {"id": "deepseek/deepseek-v4-flash-0731", "label": "DeepSeek V4 Flash",
     "blurb": "DeepSeek · about the cheapest capable tool-caller here."},
    {"id": "qwen/qwen3.7-flash", "label": "Qwen3.7 Flash",
     "blurb": "Alibaba · very low cost, 1M context. Good for bulk questions."},
    {"id": "z-ai/glm-5.2", "label": "GLM 5.2",
     "blurb": "Z.ai · strong open-weight reasoning, inexpensive."},
    {"id": "moonshotai/kimi-k3", "label": "Kimi K3",
     "blurb": "Moonshot · agentic model tuned for long tool chains."},
    {"id": "nvidia/nemotron-3-super-120b-a12b:free", "label": "Nemotron 3 Super (free)",
     "blurb": "NVIDIA · no cost, rate-limited. Handy for a demo without billing."},
]

MODELS: list[dict] = ([{**m, "provider": GOOGLE} for m in GOOGLE_MODELS]
                      + [{**m, "provider": OPENROUTER} for m in OPENROUTER_MODELS])
MODEL_IDS = {m["id"] for m in MODELS}
_BY_ID = {m["id"]: m for m in MODELS}
_MODEL_KEY = "atlas:llm:model"

# Chosen at runtime and persisted, so a restart does not silently revert the
# operator's choice to whatever the environment happens to be configured with.
_active_model: str | None = None


def provider_ready(provider: str) -> bool:
    s = get_settings()
    return bool(s.openrouter_api_key) if provider == OPENROUTER else bool(s.google_api_key)


def available_models() -> list[dict]:
    """The models this deployment's keys can actually reach."""
    return [m for m in MODELS if provider_ready(m["provider"])]


def model_provider(model_id: str) -> str:
    """Which API serves this id. An unknown id is assumed to be Google's, since
    a bare (unslashed) name is what that API takes — this keeps a hand-set
    LLM_MODEL working without it having to appear in the catalog above."""
    m = _BY_ID.get(model_id)
    return m["provider"] if m else (OPENROUTER if "/" in model_id else GOOGLE)


def current_model() -> str:
    """The model in force. Falls back when the chosen one is unreachable: a key
    that was removed (or a saved choice from when the other key was set) must not
    strand ATLAS on a model that can only fail."""
    chosen = _active_model or get_settings().llm_model
    if chosen and provider_ready(model_provider(chosen)):
        return chosen
    usable = available_models()
    return usable[0]["id"] if usable else chosen


def current_provider() -> str:
    return model_provider(current_model())


def model_catalog() -> list[dict]:
    active = current_model()
    return [{**m, "provider_label": PROVIDER_LABELS[m["provider"]], "active": m["id"] == active}
            for m in available_models()]


async def load_active_model() -> None:
    """Restore the operator's choice at startup. Silent on any failure — a model
    preference is never a reason for the app not to come up."""
    global _active_model
    try:
        from app.redis_client import get_redis
        r = await get_redis()
        if hasattr(r, "get"):
            saved = await r.get(_MODEL_KEY)
            if saved in MODEL_IDS:
                _active_model = saved
                logger.info("Reasoning model restored: %s", saved)
    except Exception as e:
        logger.warning("Could not restore model choice: %s", type(e).__name__)


async def set_active_model(model_id: str) -> dict:
    global _active_model
    if model_id not in MODEL_IDS:
        raise ValueError(f"Unknown model '{model_id}'.")
    provider = model_provider(model_id)
    if not provider_ready(provider):
        # Named rather than generic: the fix is one environment variable, and the
        # operator is the person who can go and set it.
        key = "OPENROUTER_API_KEY" if provider == OPENROUTER else "GOOGLE_API_KEY"
        raise ValueError(f"{PROVIDER_LABELS[provider]} is not configured — set {key}.")
    _active_model = model_id
    try:
        from app.redis_client import get_redis
        r = await get_redis()
        if hasattr(r, "set"):
            await r.set(_MODEL_KEY, model_id)
    except Exception as e:
        logger.warning("Model choice not persisted: %s", type(e).__name__)
    return next(m for m in model_catalog() if m["active"])


# ── OpenRouter ↔ Gemini translation ──────────────────────────────────────────
# One direction per shape. Callers keep Gemini-shaped history, so a turn that
# went out to OpenRouter must come back looking like Gemini answered it —
# including the `parts` the caller echoes into the next turn.

def _or_headers() -> dict:
    s = get_settings()
    return {
        "Authorization": f"Bearer {s.openrouter_api_key}",
        "Content-Type": "application/json",
        # Optional attribution — shows the tower on OpenRouter's app dashboards.
        "HTTP-Referer": s.openrouter_site_url,
        "X-OpenRouter-Title": s.openrouter_app_name,
    }


def _json_schema(node):
    """Gemini declares parameter types in SCREAMING case (OBJECT, STRING); JSON
    Schema — which is what OpenRouter validates against — wants them lowercase.
    Only the `type` keys are touched; descriptions and enums pass through."""
    if not isinstance(node, dict):
        return node
    out = {}
    for k, v in node.items():
        if k == "type" and isinstance(v, str):
            out[k] = v.lower()
        elif k == "properties" and isinstance(v, dict):
            out[k] = {pk: _json_schema(pv) for pk, pv in v.items()}
        elif k == "items":
            out[k] = _json_schema(v)
        else:
            out[k] = v
    return out


def _or_tools(tools: list[dict]) -> list[dict]:
    return [{"type": "function", "function": {
        "name": t.get("name", ""),
        "description": t.get("description", ""),
        "parameters": _json_schema(t.get("parameters") or {"type": "OBJECT", "properties": {}}),
    }} for t in tools]


def _or_messages(contents: list[dict], system: str | None) -> list[dict]:
    """Gemini `contents` → OpenAI `messages`.

    The one genuinely lossy edge is the tool-call id: Gemini pairs a result to
    its call by function name, OpenAI by an id the assistant turn invented. Ids
    are minted here as the assistant turn is written and handed to the results
    that follow it in order, which is exactly the pairing the caller's loop
    produces — it appends the model's calls and then their results, in step.
    """
    msgs: list[dict] = []
    if system:
        msgs.append({"role": "system", "content": system})
    pending: list[tuple[str, str]] = []      # (function name, call id) awaiting a result

    for turn in contents:
        parts = turn.get("parts") or []
        texts = [p["text"] for p in parts if isinstance(p, dict) and p.get("text")]
        calls = [p["functionCall"] for p in parts if isinstance(p, dict) and p.get("functionCall")]
        results = [p["functionResponse"] for p in parts if isinstance(p, dict) and p.get("functionResponse")]

        if results:
            # A tool-result turn is only results; it becomes one message each.
            for fr in results:
                name = fr.get("name", "")
                match = next((i for i, (n, _) in enumerate(pending) if n == name), 0 if pending else None)
                call_id = pending.pop(match)[1] if match is not None else f"call_{name}"
                msgs.append({"role": "tool", "tool_call_id": call_id, "name": name,
                             "content": json.dumps(fr.get("response", {}), default=str)[:12000]})
            continue

        if turn.get("role") == "model":
            msg: dict = {"role": "assistant", "content": "\n".join(texts)}
            if calls:
                msg["tool_calls"] = []
                for i, fc in enumerate(calls):
                    name = fc.get("name", "")
                    call_id = f"call_{len(msgs)}_{i}_{name}"[:64]
                    pending.append((name, call_id))
                    msg["tool_calls"].append({"id": call_id, "type": "function", "function": {
                        "name": name, "arguments": json.dumps(fc.get("args") or {}, default=str)}})
            msgs.append(msg)
        else:
            msgs.append({"role": "user", "content": "\n".join(texts)})
    return msgs


def _or_text(content) -> str:
    """`content` is a string on most models and a list of parts on a few."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def _or_reply(data: dict) -> dict | None:
    """OpenAI-style response → the {"text", "calls", "parts"} the callers expect,
    with `parts` rebuilt in Gemini's shape so it can be echoed back next turn."""
    choices = data.get("choices") or []
    if not choices:
        return None
    msg = choices[0].get("message") or {}
    text = _or_text(msg.get("content")).strip()
    parts: list[dict] = [{"text": text}] if text else []
    calls: list[dict] = []
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        name = fn.get("name", "")
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except (ValueError, TypeError):
            args = {}
        if not isinstance(args, dict):
            args = {}
        calls.append({"name": name, "args": args})
        parts.append({"functionCall": {"name": name, "args": args}})
    return {"text": text, "calls": calls, "parts": parts}


async def _or_post(url: str, body: dict, timeout: float, *, what: str) -> httpx.Response | None:
    """One OpenRouter request. Returns None on anything that is not a 200 so the
    caller's existing fall-back path handles it unchanged."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(url, headers=_or_headers(), json=body)
        if r.status_code != 200:
            logger.warning("OpenRouter %s (%s) returned %s: %s",
                           what, body.get("model"), r.status_code, r.text[:300])
            return None
        return r
    except Exception as e:
        logger.warning("OpenRouter %s failed: %s", what, type(e).__name__)
        return None


# ── Voice ────────────────────────────────────────────────────────────────────
# Speech is a shell around the text turn, never a replacement for it. The Live
# (bidi) API would stream a spoken conversation INSTEAD of composing an answer,
# which would cost the markdown, the reasoning trail and the approval cards the
# panel is built on. So audio is bookended: speech in becomes a question, the
# ordinary grounded pipeline answers it, and the answer is read back.
#
# One voice, two routes: OpenRouter serves this very model as
# `google/gemini-3.1-flash-tts-preview` (see OPENROUTER_TTS_MODEL), so the tower
# does not change how it sounds when an operator switches reasoning provider.
TTS_MODEL = "gemini-3.1-flash-tts-preview"
DEFAULT_VOICE = "Kore"
VOICES = [
    {"id": "Kore", "label": "Kore", "blurb": "Even and clear. The default."},
    {"id": "Charon", "label": "Charon", "blurb": "Lower, measured — good for long briefings."},
    {"id": "Aoede", "label": "Aoede", "blurb": "Brighter and quicker."},
    {"id": "Puck", "label": "Puck", "blurb": "Warmer, more conversational."},
]
VOICE_IDS = {v["id"] for v in VOICES}

# Formats the API accepts inline. Anything else is re-encoded to WAV in the
# browser before it is sent.
AUDIO_MIME = {"audio/wav", "audio/x-wav", "audio/mp3", "audio/mpeg",
              "audio/aiff", "audio/aac", "audio/ogg", "audio/flac"}

# OpenRouter's transcription endpoint names the container rather than its mime.
_AUDIO_FORMAT = {"audio/wav": "wav", "audio/x-wav": "wav", "audio/mp3": "mp3",
                 "audio/mpeg": "mp3", "audio/aiff": "aiff", "audio/aac": "aac",
                 "audio/ogg": "ogg", "audio/flac": "flac"}


def _wav(pcm: bytes, sample_rate: int = 24000, channels: int = 1, bits: int = 16) -> bytes:
    """Wrap raw PCM in a WAV header. Gemini returns headerless L16; a browser
    will not play that, and doing it here keeps the client free of audio plumbing."""
    import struct
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    return (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, bits)
            + b"data" + struct.pack("<I", len(pcm)) + pcm)


# Below these an audio clip is not speech, whatever a model makes of it.
MIN_SPEECH_SECONDS = 0.35
MIN_SPEECH_RMS = 110        # 16-bit scale; quiet room noise sits well under this


def audio_has_speech(wav: bytes) -> bool | None:
    """Does this WAV actually contain someone speaking?

    Asked to transcribe one second of digital silence, the model does not answer
    "nothing" — it invents a plausible control-tower question ("What is the
    current status of shipment 4592?"). Handed to a pipeline that can execute
    actions, a fabricated instruction is the worst possible failure, so whether
    there is speech at all is decided by arithmetic on the samples and never by
    the model. Returns None when the bytes are not WAV and cannot be judged here.
    """
    import struct
    try:
        if len(wav) < 44 or wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
            return None
        pos, rate, bits, channels, data = 12, 24000, 16, 1, b""
        while pos + 8 <= len(wav):
            cid = wav[pos:pos + 4]
            size = struct.unpack("<I", wav[pos + 4:pos + 8])[0]
            body = wav[pos + 8:pos + 8 + size]
            if cid == b"fmt " and len(body) >= 16:
                _, channels, rate, _, _, bits = struct.unpack("<HHIIHH", body[:16])
            elif cid == b"data":
                data = body
            pos += 8 + size + (size & 1)
        if not data or bits != 16 or rate <= 0:
            return None
        frames = len(data) // 2
        if frames / max(1, rate * max(1, channels)) < MIN_SPEECH_SECONDS:
            return False
        samples = struct.unpack(f"<{frames}h", data[:frames * 2])
        # Peak-relative RMS: a clip that is uniformly quiet is silence, but a
        # quiet clip with speech in part of it still has energy to find.
        step = max(1, frames // 8000)                    # sample, don't grind
        picked = samples[::step]
        rms = (sum(s * s for s in picked) / len(picked)) ** 0.5
        peak = max(abs(s) for s in picked)
        return rms >= MIN_SPEECH_RMS and peak >= 900
    except Exception:
        return None


async def transcribe(audio_b64: str, mime_type: str = "audio/wav") -> str | None:
    """Spoken question → text, using the model the operator already selected.

    Returns None on any failure so the caller can tell them to type instead —
    a mis-heard instruction to a system with hands is worse than no instruction.
    """
    s = get_settings()
    if not llm_available():
        return None

    if current_provider() == OPENROUTER:
        # A dedicated speech-to-text model rather than the chat model: OpenRouter
        # has no Gemini audio-in equivalent, and a purpose-built recogniser cannot
        # be talked into answering the question instead of transcribing it. The
        # silence guard still runs before this — `audio_has_speech` in the router
        # — because an ASR model handed near-silence will still emit *something*.
        r = await _or_post(_OR_TRANSCRIBE_URL, {
            "model": s.openrouter_stt_model,
            "input_audio": {"data": audio_b64, "format": _AUDIO_FORMAT.get(mime_type, "wav")},
            "language": "en",
        }, 45.0, what="transcription")
        if r is None:
            return None
        try:
            text = str((r.json() or {}).get("text") or "").strip()
        except ValueError:
            return None
        return text or None

    body = {
        "contents": [{"role": "user", "parts": [
            {"text": "Transcribe this audio verbatim as a question or instruction for a logistics "
                     "control tower. Output ONLY the transcript, with no commentary, quotes or "
                     "preamble.\n"
                     "If the audio is silent, inaudible, or contains no discernible speech, output "
                     "exactly NO_SPEECH. Never invent a plausible question to fill a gap — a "
                     "fabricated instruction here could cause a real action to be taken."},
            {"inlineData": {"mimeType": mime_type, "data": audio_b64}},
        ]}],
        "generationConfig": {"maxOutputTokens": 300, "temperature": 0.0},
    }
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            r = await client.post(_URL.format(model=current_model()),
                                  params={"key": s.google_api_key}, json=body)
        if r.status_code != 200:
            logger.warning("Transcription returned %s: %s", r.status_code, r.text[:200])
            return None
        cands = r.json().get("candidates", [])
        if not cands:
            return None
        text = "".join(p.get("text", "") for p in cands[0].get("content", {}).get("parts", [])).strip()
        return None if not text or text.strip() == "NO_SPEECH" else text
    except Exception as e:
        logger.warning("Transcription failed: %s", type(e).__name__)
        return None


async def synthesize(text: str, voice: str = DEFAULT_VOICE) -> bytes | None:
    """Text → WAV bytes, ready for an <audio> element."""
    s = get_settings()
    if not llm_available() or not text.strip():
        return None
    voice = voice if voice in VOICE_IDS else DEFAULT_VOICE

    if current_provider() == OPENROUTER:
        # Deliberately the *same* TTS model as the Google-direct path — OpenRouter
        # serves `google/gemini-3.1-flash-tts-preview`, so the tower keeps one
        # voice whichever way the request is routed, and the voice names below
        # (Kore, Charon…) are the model's own and pass straight through.
        # `pcm` is asked for rather than `mp3` because this endpoint's contract is
        # WAV: Gemini emits headerless 24 kHz 16-bit mono, which _wav() wraps.
        r = await _or_post(_OR_SPEECH_URL, {
            "model": s.openrouter_tts_model,
            "input": text,
            "voice": voice,
            "response_format": "pcm",
        }, 120.0, what="TTS")
        return _wav(r.content) if r is not None and r.content else None

    body = {
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(_URL.format(model=TTS_MODEL),
                                  params={"key": s.google_api_key}, json=body)
        if r.status_code != 200:
            logger.warning("TTS returned %s: %s", r.status_code, r.text[:200])
            return None
        parts = r.json()["candidates"][0]["content"]["parts"]
        inline = next((p["inlineData"] for p in parts if p.get("inlineData")), None)
        if not inline:
            return None
        import base64 as _b64
        pcm = _b64.b64decode(inline["data"])
        rate = 24000
        for bit in str(inline.get("mimeType", "")).split(";"):
            if "rate=" in bit:
                try:
                    rate = int(bit.split("rate=")[1])
                except ValueError:
                    pass
        return _wav(pcm, sample_rate=rate)
    except Exception as e:
        logger.warning("TTS failed: %s", type(e).__name__)
        return None


def llm_available() -> bool:
    """Either key is enough — the catalog only ever offers models a configured
    key can reach, so "available" means at least one provider is wired up."""
    s = get_settings()
    return s.llm_enabled and bool(s.google_api_key or s.openrouter_api_key)


async def generate(prompt: str, *, system: str | None = None,
                   max_tokens: int = 220, temperature: float = 0.3) -> str | None:
    s = get_settings()
    if not llm_available():
        return None
    if current_provider() == OPENROUTER:
        msgs = ([{"role": "system", "content": system}] if system else []) + \
               [{"role": "user", "content": prompt}]
        r = await _or_post(_OR_CHAT_URL, {
            "model": current_model(), "messages": msgs,
            "max_tokens": max_tokens, "temperature": temperature, "top_p": 0.9,
        }, 15.0, what="generate")
        if r is None:
            return None
        try:
            reply = _or_reply(r.json())
        except ValueError:
            return None
        return (reply or {}).get("text") or None

    body: dict = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "maxOutputTokens": max_tokens,
            "temperature": temperature,
            "topP": 0.9,
        },
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(
                _URL.format(model=current_model()),
                params={"key": s.google_api_key},
                json=body,
            )
        if r.status_code != 200:
            logger.warning("Gemini %s returned %s", current_model(), r.status_code)
            return None
        cands = r.json().get("candidates", [])
        if not cands:
            return None
        parts = cands[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts).strip()
        return text or None
    except Exception as e:  # network, timeout, shape — all fall back
        logger.warning("Gemini call failed: %s", type(e).__name__)
        return None


async def converse(contents: list[dict], *, system: str | None = None,
                   tools: list[dict] | None = None, max_tokens: int = 1200,
                   temperature: float = 0.35, timeout: float = 30.0,
                   force_tool: str | None = None) -> dict | None:
    """One turn of a tool-capable conversation.

    `contents` is the raw Gemini content list (the caller keeps the history, so a
    tool result is appended to it and this is called again). Returns

        {"text": str, "calls": [{"name": str, "args": dict}], "parts": [...]}

    where `parts` is the model's verbatim content — it has to be echoed back into
    the next turn's history or Gemini loses the thread of its own tool call.
    Returns None on any failure so the caller falls back to deterministic answers.

    `force_tool` names one function the model MUST call this turn. Normal turns
    leave the choice to the model; this is for the case where the model has
    already told the operator it did something and only the call is missing.
    """
    s = get_settings()
    if not llm_available():
        return None

    if current_provider() == OPENROUTER:
        body: dict = {
            "model": current_model(),
            "messages": _or_messages(contents, system),
            "max_tokens": max_tokens,
            "temperature": temperature,
            "top_p": 0.9,
        }
        if tools:
            body["tools"] = _or_tools(tools)
            body["tool_choice"] = ({"type": "function", "function": {"name": force_tool}}
                                   if force_tool else "auto")
        r = await _or_post(_OR_CHAT_URL, body, timeout, what="converse")
        if r is None:
            return None
        try:
            return _or_reply(r.json())
        except ValueError:
            logger.warning("OpenRouter returned a non-JSON body for %s", current_model())
            return None

    body = {
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": max_tokens,
            "temperature": temperature,
            "topP": 0.9,
        },
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if tools:
        body["tools"] = [{"functionDeclarations": tools}]
        body["toolConfig"] = {"functionCallingConfig": (
            {"mode": "ANY", "allowedFunctionNames": [force_tool]} if force_tool
            else {"mode": "AUTO"})}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(
                _URL.format(model=current_model()),
                params={"key": s.google_api_key},
                json=body,
            )
        if r.status_code != 200:
            logger.warning("Gemini %s (tools) returned %s: %s", current_model(), r.status_code, r.text[:300])
            return None
        cands = r.json().get("candidates", [])
        if not cands:
            return None
        parts = cands[0].get("content", {}).get("parts", []) or []
        calls = [
            {"name": p["functionCall"].get("name", ""), "args": dict(p["functionCall"].get("args") or {})}
            for p in parts if isinstance(p, dict) and p.get("functionCall")
        ]
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()
        return {"text": text, "calls": calls, "parts": parts}
    except Exception as e:
        logger.warning("Gemini tool call failed: %s", type(e).__name__)
        return None
