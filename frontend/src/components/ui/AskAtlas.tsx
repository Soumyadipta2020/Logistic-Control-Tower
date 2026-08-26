// Ask ATLAS — the conversational surface of the agentic layer.
//
// The other tabs are shaped like the work: a queue to triage, a log to audit, a
// policy table to read. This one is shaped like a colleague, and a colleague you
// can only ask questions of is half a colleague. So the console does three things
// the old one did not:
//
//   1. ANSWERS PROPERLY. Replies arrive as markdown — headline, bullets, tables —
//      and are rendered as such. An answer comparing four carriers on three fields
//      is a table; flattening it to a paragraph of asterisks wastes the reasoning.
//   2. SHOWS ITS WORK. Every state read and every action attempt is surfaced as a
//      step chip above the answer, so "how do you know that" never needs asking.
//   3. ACTS. When ATLAS can run something under policy it runs it and reports what
//      changed; when it cannot, the action arrives as an approval card in the
//      thread, carrying the same governance reasoning the approvals queue shows.
//      The decision is made where the conversation happened, not two tabs away.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Sparkles, Send, Copy, Check, RefreshCw, Zap, ShieldAlert, ShieldCheck, UserCheck,
  Search, ScrollText, Wrench, SlidersHorizontal, AlertTriangle, X, ChevronDown, ChevronRight,
  Radar, MessageSquarePlus, CornerDownLeft, History, Trash2, Loader2,
  Mic, Square, Volume2, VolumeX,
} from 'lucide-react'
import {
  askAtlas, decideAtlasProposal, fetchAtlasConversations, fetchAtlasConversation,
  deleteAtlasConversation, transcribeAudio, speakAnswer,
  type AtlasReply, type AtlasAction, type AtlasStep, type AtlasTurn, type AtlasConversation,
} from '../../lib/api'
import { startRecording, blobToWav, playWav, stopSpeaking, type Recording } from '../../lib/voice'
import { Markdown } from '../../lib/markdown'
import { MASTER_AGENT } from '../../lib/aiTabs'
import { AtlasMark } from './AtlasMark'

// The thread survives a tab reload, which means it can outlive the shape it was
// stored in. A message saved by an older build carries no steps and no proposals,
// and was written by a model that had been told to answer in plain text — so it
// renders forever as an unformatted answer with no approval card, looking exactly
// like a broken feature. Versioning the key means a shape change discards the old
// conversation instead of degrading every reply in it.
const STORE_KEY = 'clt_atlas_thread_v2'
const CONV_KEY = 'clt_atlas_conversation'
const VOICE_KEY = 'clt_atlas_read_aloud'
const LEGACY_STORE_KEYS = ['clt_atlas_thread']
const MAX_SENT_HISTORY = 8
// Under this there is nothing to transcribe. Caught here so a mis-tapped mic
// never costs a round trip, and never reaches a model that would rather invent
// a plausible instruction than admit it heard nothing.
const MIN_CLIP_SECONDS = 0.35
const MIN_CLIP_LEVEL = 0.006

type Decision = { status: 'executed' | 'declined' | 'failed'; summary?: string }

interface Msg {
  id: string
  role: 'user' | 'atlas' | 'error'
  text: string
  at: string
  source?: 'gemini' | 'rules'
  model?: string | null
  steps?: AtlasStep[]
  executed?: AtlasAction[]
  proposals?: AtlasAction[]
  suggestions?: string[]
}

const uid = () => Math.random().toString(36).slice(2, 10)

// What ATLAS is doing while the request is in flight. The phases are the real
// shape of a turn (read state → reason → check policy), so the wait describes
// the work rather than just occupying the eye.
const PHASES = ['Reading live state…', 'Reasoning over the network…', 'Checking policy…', 'Composing the answer…']

const STARTERS: { icon: React.ElementType; accent: string; title: string; blurb: string; prompt: string }[] = [
  { icon: Search, accent: '#3B82F6', title: 'Ask anything about now',
    blurb: 'Every KPI, SKU, supplier, van and locker in live state.',
    prompt: 'Give me the state of the network in five lines — what is broken and what is holding.' },
  { icon: ScrollText, accent: '#8B5CF6', title: 'Interrogate a decision',
    blurb: 'Why something is queued, what it commits, what policy says.',
    prompt: 'What needs my approval right now, and which would you approve first and why?' },
  { icon: Wrench, accent: '#10B981', title: 'Get it done',
    blurb: 'Routine actions run instantly; high-stakes ones ask you first.',
    prompt: 'Sort out the vans that are short for tomorrow morning.' },
  { icon: SlidersHorizontal, accent: '#F59E0B', title: 'Set the guardrails',
    blurb: 'Autonomy, spend limits and what always comes to a human.',
    prompt: 'What are you allowed to do without asking me, and where do you stop?' },
]

const CLASS_TONE: Record<string, { color: string; label: string; icon: React.ElementType }> = {
  auto:  { color: '#10B981', label: 'Autonomous',     icon: Zap },
  human: { color: '#8B5CF6', label: 'Human decision', icon: UserCheck },
  dual:  { color: '#EF4444', label: 'Dual control',   icon: ShieldAlert },
}

export function AskAtlas({ llmEnabled, model, onStateChanged, onOpenModule }: {
  llmEnabled: boolean
  model?: string
  onStateChanged?: () => void
  onOpenModule?: (route: string) => void
}) {
  const [messages, setMessages] = useState<Msg[]>(() => {
    try {
      LEGACY_STORE_KEYS.forEach((k) => sessionStorage.removeItem(k))
      const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]')
      return Array.isArray(saved) ? saved : []
    } catch { return [] }
  })
  const [input, setInput] = useState('')
  const [phase, setPhase] = useState(0)
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [conversationId, setConversationId] = useState<string | null>(() => sessionStorage.getItem(CONV_KEY))
  const [historyOpen, setHistoryOpen] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [readAloud, setReadAloud] = useState(() => localStorage.getItem(VOICE_KEY) === '1')
  const [recording, setRecording] = useState(false)
  const [recSeconds, setRecSeconds] = useState(0)
  const [transcribing, setTranscribing] = useState(false)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const recRef = useRef<Recording | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)
  const queryClient = useQueryClient()

  useEffect(() => {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-40))) } catch { /* quota — the thread is not precious */ }
  }, [messages])

  // The rail is only fetched once it is opened — history is a side surface, not
  // a cost every operator pays for opening the chat.
  const { data: conversations = [], isFetching: loadingList } = useQuery({
    queryKey: ['atlas-conversations'],
    queryFn: () => fetchAtlasConversations(30),
    enabled: historyOpen,
    staleTime: 15_000,
  })

  const ask = useMutation({
    mutationFn: ({ q, history }: { q: string; history: AtlasTurn[] }) => askAtlas(q, history, conversationId),
    onSuccess: (data: AtlasReply) => {
      const reply: Msg = {
        id: uid(), role: 'atlas', text: data.answer, at: data.at ?? new Date().toISOString(),
        source: data.source, model: data.model, steps: data.steps, executed: data.executed,
        proposals: data.proposals, suggestions: data.suggestions,
      }
      setMessages((m) => [...m, reply])
      // Read it out only after it is on screen: the written answer is the record,
      // the spoken one is a convenience over it — never the other way round.
      if (readAloud) speak(reply)
      if (data.conversation_id) {
        setConversationId(data.conversation_id)
        sessionStorage.setItem(CONV_KEY, data.conversation_id)
      }
      queryClient.invalidateQueries({ queryKey: ['atlas-conversations'] })
      if (data.executed?.length) onStateChanged?.()
    },
    onError: (err: any) => {
      setMessages((m) => [...m, {
        id: uid(), role: 'error', at: new Date().toISOString(),
        text: err?.response?.data?.detail || 'I could not reach the reasoning layer. The live state below is unaffected — try again.',
      }])
    },
  })

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'decline' }) =>
      decideAtlasProposal(id, decision),
    onSuccess: (data: any, vars) => {
      setDecisions((d) => ({ ...d, [vars.id]: {
        status: vars.decision === 'approve' ? (data?.ok ? 'executed' : 'failed') : 'declined',
        summary: data?.summary,
      } }))
      if (vars.decision === 'approve') onStateChanged?.()
    },
    onError: (err: any, vars) => {
      setDecisions((d) => ({ ...d, [vars.id]: { status: 'failed', summary: err?.response?.data?.detail || 'Could not execute.' } }))
    },
  })

  // Rotate the waiting phases so a long turn reads as progress, not a hang.
  useEffect(() => {
    if (!ask.isPending) { setPhase(0); return }
    const t = setInterval(() => setPhase((p) => Math.min(p + 1, PHASES.length - 1)), 2600)
    return () => clearInterval(t)
  }, [ask.isPending])

  // Follow the conversation down — unless the operator has scrolled up to read.
  useEffect(() => {
    const el = threadRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, ask.isPending, decisions])

  const onThreadScroll = () => {
    const el = threadRef.current
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  const submit = useCallback((raw: string) => {
    const q = raw.trim()
    if (!q || ask.isPending) return
    const history: AtlasTurn[] = messages
      .filter((m) => m.role !== 'error')
      .slice(-MAX_SENT_HISTORY)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', text: m.text }))
    stickToBottom.current = true
    setMessages((m) => [...m, { id: uid(), role: 'user', text: q, at: new Date().toISOString() }])
    setInput('')
    if (boxRef.current) boxRef.current.style.height = 'auto'
    ask.mutate({ q, history })
  }, [ask, messages])

  // ── voice ─────────────────────────────────────────────────────────────────
  // Speech is a shell around the text turn: the transcript is sent as an ordinary
  // question, so a spoken instruction and a typed one hit the same grounded
  // pipeline, the same governance and the same approval cards.

  const speak = useCallback(async (msg: Msg) => {
    if (!msg.text) return
    stopSpeaking()
    setSpeakingId(msg.id)
    try {
      const wav = await speakAnswer(msg.text, { executed: msg.executed, proposals: msg.proposals })
      await playWav(wav, msg.id)
    } catch {
      // The answer is on screen; a failed read-back is not worth an error bubble.
    } finally {
      setSpeakingId((id) => (id === msg.id ? null : id))
    }
  }, [])

  const toggleSpeak = (msg: Msg) => {
    if (speakingId === msg.id) { stopSpeaking(); setSpeakingId(null) } else { speak(msg) }
  }

  const toggleReadAloud = () => {
    setReadAloud((on) => {
      const next = !on
      localStorage.setItem(VOICE_KEY, next ? '1' : '0')
      if (!next) { stopSpeaking(); setSpeakingId(null) }
      return next
    })
  }

  const stopRecording = async (send: boolean) => {
    const rec = recRef.current
    recRef.current = null
    setRecording(false)
    if (!rec) return
    if (!send) { rec.cancel(); return }

    setTranscribing(true)
    try {
      const clip = await rec.stop()
      const { base64, seconds, level } = await blobToWav(clip)
      if (seconds < MIN_CLIP_SECONDS || level < MIN_CLIP_LEVEL) {
        setMessages((m) => [...m, { id: uid(), role: 'error', at: new Date().toISOString(),
          text: "I didn't hear anything — hold the mic while you speak, or type your question." }])
        return
      }
      const text = await transcribeAudio(base64)
      if (text?.trim()) submit(text.trim())
    } catch (err: any) {
      setMessages((m) => [...m, { id: uid(), role: 'error', at: new Date().toISOString(),
        text: err?.response?.data?.detail || 'I could not make out that recording — try again, or type it.' }])
    } finally {
      setTranscribing(false)
    }
  }

  const beginRecording = async () => {
    if (recording || transcribing || ask.isPending) return
    stopSpeaking(); setSpeakingId(null)
    try {
      recRef.current = await startRecording()
      setRecSeconds(0)
      setRecording(true)
    } catch {
      setMessages((m) => [...m, { id: uid(), role: 'error', at: new Date().toISOString(),
        text: 'I could not reach the microphone. Check the browser has permission, then try again.' }])
    }
  }

  // Recording length, and a hard stop so a forgotten mic cannot record forever.
  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setRecSeconds((s) => {
      if (s + 1 >= 60) { stopRecording(true); return s }
      return s + 1
    }), 1000)
    return () => clearInterval(t)
  }, [recording])

  // Stop any audio when the panel goes away — a disembodied voice after the
  // operator has moved on is worse than silence.
  useEffect(() => () => { stopSpeaking(); recRef.current?.cancel() }, [])

  const retry = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUser) {
      setMessages((m) => m.filter((x) => x.role !== 'error'))
      submit(lastUser.text)
    }
  }

  const reset = () => {
    setMessages([]); setDecisions({}); setInput(''); setConversationId(null)
    sessionStorage.removeItem(STORE_KEY)
    sessionStorage.removeItem(CONV_KEY)
    LEGACY_STORE_KEYS.forEach((k) => sessionStorage.removeItem(k))
    boxRef.current?.focus()
  }

  // Reopening a conversation restores it as it was rendered — including the
  // actions it took — and settles any approval card the ledger has since
  // decided or forgotten, so nothing offers a button that cannot be pressed.
  const openConversation = async (id: string) => {
    if (id === conversationId || loadingId) return
    setLoadingId(id)
    try {
      const conv = await fetchAtlasConversation(id)
      setMessages(conv.messages.map((m: any) => ({ ...m, id: uid() })))
      setDecisions(Object.fromEntries(Object.entries(conv.proposal_states ?? {}).map(
        ([pid, s]) => [pid, { status: s.status === 'executed' ? 'executed' : s.status === 'declined' ? 'declined' : 'failed', summary: s.summary }]
      )) as Record<string, Decision>)
      setConversationId(id)
      sessionStorage.setItem(CONV_KEY, id)
      stickToBottom.current = true
    } catch {
      setMessages((m) => [...m, { id: uid(), role: 'error', at: new Date().toISOString(),
        text: 'That conversation could not be loaded — it may have expired.' }])
    } finally {
      setLoadingId(null)
    }
  }

  const removeConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await deleteAtlasConversation(id).catch(() => {})
    queryClient.invalidateQueries({ queryKey: ['atlas-conversations'] })
    if (id === conversationId) reset()
  }

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }

  const lastAtlas = useMemo(() => [...messages].reverse().find((m) => m.role === 'atlas'), [messages])
  const chips = lastAtlas?.suggestions?.length ? lastAtlas.suggestions : []

  return (
    <div className="atlas-chat">
      {/* Header — identity, what it is grounded in, and a way out of the thread */}
      <div className="atlas-chat-head">
        <AtlasMark className="atlas-head-orb" glyph={15} />
        <div style={{ minWidth: 0 }}>
          <div className="atlas-head-title">
            Ask {MASTER_AGENT.name}
            {llmEnabled
              ? <span className="gemini-chip"><Sparkles size={10} /> {model}</span>
              : <span className="atlas-mode-chip">grounded rules mode</span>}
          </div>
          <div className="atlas-head-sub">
            Reads the whole live control tower · acts inside the same policy that governs the approvals queue
          </div>
        </div>
        <div className="atlas-head-actions">
          <button className={`atlas-head-btn${readAloud ? ' on' : ''}`} onClick={toggleReadAloud}
            title={readAloud ? 'Answers are read aloud — click to mute' : 'Read answers aloud after they appear'}
            aria-pressed={readAloud}>
            {readAloud ? <Volume2 size={13} /> : <VolumeX size={13} />} {readAloud ? 'Voice on' : 'Voice off'}
          </button>
          <button className={`atlas-head-btn${historyOpen ? ' on' : ''}`} onClick={() => setHistoryOpen((o) => !o)}
            title="Past conversations" aria-pressed={historyOpen}>
            <History size={13} /> History
          </button>
          {messages.length > 0 && (
            <button className="atlas-head-btn" onClick={reset} title="Start a new conversation">
              <MessageSquarePlus size={13} /> New chat
            </button>
          )}
        </div>
      </div>

      <div className="atlas-chat-body">
        {historyOpen && (
          <HistoryRail conversations={conversations} loading={loadingList} activeId={conversationId}
            loadingId={loadingId} onOpen={openConversation} onDelete={removeConversation}
            onNew={reset} onClose={() => setHistoryOpen(false)} />
        )}
        <div className="atlas-chat-main">

      {/* Thread */}
      <div className="atlas-thread" ref={threadRef} onScroll={onThreadScroll}>
        {messages.length === 0 ? (
          <Welcome onPick={submit} llmEnabled={llmEnabled} />
        ) : (
          messages.map((m) => (
            <MessageRow key={m.id} msg={m} decisions={decisions}
              onDecide={(id, decision) => decide.mutate({ id, decision })}
              deciding={decide.isPending ? decide.variables?.id : null}
              onRetry={retry} onAsk={submit} onOpenModule={onOpenModule}
              speaking={speakingId === m.id} onSpeak={() => toggleSpeak(m)} />
          ))
        )}
        {ask.isPending && (
          <div className="atlas-msg atlas-msg-atlas">
            <AtlasMark className="atlas-msg-orb" glyph={15} />
            <div className="atlas-thinking">
              <span className="atlas-dots"><i /><i /><i /></span>
              <span className="atlas-thinking-text">{PHASES[phase]}</span>
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="atlas-composer">
        {chips.length > 0 && !ask.isPending && (
          <div className="atlas-chips">
            {chips.map((s) => (
              <button key={s} className="atlas-chip" onClick={() => submit(s)}>{s}</button>
            ))}
          </div>
        )}
        {recording ? (
          <div className="atlas-recording">
            <span className="atlas-rec-dot" />
            <span className="atlas-rec-label">Listening…</span>
            <span className="atlas-rec-time">{`0:${String(recSeconds).padStart(2, '0')}`}</span>
            <span className="atlas-rec-hint">Speak your question, then stop</span>
            <button className="btn btn-secondary btn-sm" onClick={() => stopRecording(false)}>Cancel</button>
            <button className="btn btn-sm atlas-rec-stop" onClick={() => stopRecording(true)}>
              <Square size={12} /> Stop &amp; send
            </button>
          </div>
        ) : (
          <div className="atlas-input-wrap">
            <button className="atlas-mic" onClick={beginRecording}
              disabled={transcribing || ask.isPending}
              title="Ask by voice" aria-label="Ask by voice">
              {transcribing ? <Loader2 size={15} className="atlas-spin" /> : <Mic size={15} />}
            </button>
            <textarea
              ref={boxRef}
              className="atlas-input"
              rows={1}
              value={input}
              placeholder={transcribing ? 'Transcribing what you said…'
                : `Ask about anything in the network — or tell ${MASTER_AGENT.name} to fix it…`}
              onChange={(e) => { setInput(e.target.value); grow(e.target) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input) }
              }}
              aria-label={`Ask ${MASTER_AGENT.name}`}
            />
            <button className="atlas-send" disabled={ask.isPending || !input.trim()} onClick={() => submit(input)}
              title="Send (Enter)">
              {ask.isPending ? <RefreshCw size={15} className="atlas-spin" /> : <Send size={15} />}
            </button>
          </div>
        )}
        <div className="atlas-composer-foot">
          <span><CornerDownLeft size={10} /> Enter to send · Shift + Enter for a new line · <Mic size={10} /> to speak</span>
          <span className="atlas-composer-policy">
            <ShieldCheck size={11} /> Routine actions run immediately · high-stakes ones come back for your approval
          </span>
        </div>
      </div>
        </div>
      </div>
    </div>
  )
}

// ─── history rail ────────────────────────────────────────────────────────────
// Past conversations are a record of what was asked during an incident and what
// was done about it — so they are grouped by when, and labelled by what they
// changed, not just by their opening question.

function HistoryRail({ conversations, loading, activeId, loadingId, onOpen, onDelete, onNew, onClose }: {
  conversations: AtlasConversation[]
  loading: boolean
  activeId: string | null
  loadingId: string | null
  onOpen: (id: string) => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onNew: () => void
  onClose: () => void
}) {
  const groups = useMemo(() => {
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const buckets: { label: string; items: AtlasConversation[] }[] = [
      { label: 'Today', items: [] }, { label: 'Yesterday', items: [] }, { label: 'Earlier', items: [] },
    ]
    conversations.forEach((c) => {
      const t = new Date(c.updated_at).getTime()
      const idx = t >= startOfToday ? 0 : t >= startOfToday - 86_400_000 ? 1 : 2
      buckets[idx].items.push(c)
    })
    return buckets.filter((b) => b.items.length > 0)
  }, [conversations])

  return (
    <aside className="atlas-history">
      <div className="atlas-history-head">
        <span>Conversations</span>
        <button className="atlas-icon-btn" onClick={onClose} title="Hide history"><X size={12} /></button>
      </div>
      <button className="atlas-history-new" onClick={onNew}><MessageSquarePlus size={13} /> New conversation</button>

      <div className="atlas-history-list">
        {loading && conversations.length === 0 && (
          <div className="atlas-history-empty"><Loader2 size={13} className="atlas-spin" /> Loading…</div>
        )}
        {!loading && conversations.length === 0 && (
          <div className="atlas-history-empty">No conversations yet. Anything you ask is kept here.</div>
        )}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="atlas-history-group">{g.label}</div>
            {g.items.map((c) => (
              <button key={c.id} onClick={() => onOpen(c.id)}
                className={`atlas-history-item${c.id === activeId ? ' active' : ''}`}>
                <span className="atlas-history-title">{c.title}</span>
                {c.preview && <span className="atlas-history-preview">{c.preview}</span>}
                <span className="atlas-history-meta">
                  {timeAgo(c.updated_at)} · {c.message_count} message{c.message_count === 1 ? '' : 's'}
                  {c.actions > 0 && <b className="ran"><Zap size={9} /> {c.actions} ran</b>}
                  {c.proposals > 0 && <b className="asked"><UserCheck size={9} /> {c.proposals} asked</b>}
                </span>
                {loadingId === c.id
                  ? <Loader2 size={12} className="atlas-spin atlas-history-del" />
                  : <span className="atlas-history-del" onClick={(e) => onDelete(c.id, e)} title="Delete this conversation"><Trash2 size={12} /></span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}

function timeAgo(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// ─── empty state ─────────────────────────────────────────────────────────────

function Welcome({ onPick, llmEnabled }: { onPick: (q: string) => void; llmEnabled: boolean }) {
  return (
    <div className="atlas-welcome">
      <AtlasMark className="atlas-welcome-orb" glyph={26} strokeWidth={1.9} />
      <div className="atlas-welcome-title">What do you need?</div>
      <div className="atlas-welcome-sub">
        {MASTER_AGENT.name} answers from live state — never from memory — and can act on what it finds.
        {!llmEnabled && ' No reasoning key is configured, so answers come from the deterministic engine.'}
      </div>
      <div className="atlas-starters">
        {STARTERS.map((s) => (
          <button key={s.title} className="atlas-starter" onClick={() => onPick(s.prompt)}
            style={{ borderTop: `2px solid ${s.accent}` }}>
            <span className="atlas-starter-icon" style={{ background: `${s.accent}18`, border: `1px solid ${s.accent}33` }}>
              <s.icon size={14} color={s.accent} />
            </span>
            <span className="atlas-starter-title">{s.title}</span>
            <span className="atlas-starter-blurb">{s.blurb}</span>
            <span className="atlas-starter-prompt">“{s.prompt}”</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── one message ─────────────────────────────────────────────────────────────

function MessageRow({ msg, decisions, onDecide, deciding, onRetry, onAsk, onOpenModule, speaking, onSpeak }: {
  msg: Msg
  decisions: Record<string, Decision>
  onDecide: (id: string, decision: 'approve' | 'decline') => void
  deciding: string | null
  onRetry: () => void
  onAsk: (q: string) => void
  onOpenModule?: (route: string) => void
  speaking?: boolean
  onSpeak?: () => void
}) {
  const [copied, setCopied] = useState(false)

  if (msg.role === 'user') {
    return (
      <div className="atlas-msg atlas-msg-user">
        <div className="atlas-bubble-user">{msg.text}</div>
      </div>
    )
  }

  if (msg.role === 'error') {
    return (
      <div className="atlas-msg atlas-msg-atlas">
        <span className="atlas-msg-orb atlas-msg-orb-error"><AlertTriangle size={12} /></span>
        <div className="atlas-error">
          <span>{msg.text}</span>
          <button className="btn btn-secondary btn-sm" onClick={onRetry}><RefreshCw size={12} /> Retry</button>
        </div>
      </div>
    )
  }

  const copy = () => {
    navigator.clipboard?.writeText(msg.text).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1600)
    }).catch(() => { /* clipboard unavailable — nothing to recover */ })
  }

  return (
    <div className="atlas-msg atlas-msg-atlas">
      <AtlasMark className="atlas-msg-orb" glyph={15} />
      <div className="atlas-answer">
        <div className="atlas-answer-head">
          <b>{MASTER_AGENT.name}</b>
          <span className={`atlas-source ${msg.source === 'gemini' ? 'llm' : 'rules'}`}>
            {msg.source === 'gemini' ? msg.model || 'Gemini' : 'Rules engine'}
          </span>
          <span className="atlas-answer-time">{new Date(msg.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
          {onSpeak && (
            <button className={`atlas-icon-btn${speaking ? ' speaking' : ''}`} onClick={onSpeak}
              title={speaking ? 'Stop reading' : 'Read this answer aloud'}
              style={{ marginLeft: 'auto' }}>
              {speaking ? <Square size={11} /> : <Volume2 size={12} />}
            </button>
          )}
          <button className="atlas-icon-btn" onClick={copy} title="Copy this answer"
            style={onSpeak ? { marginLeft: 0 } : undefined}>
            {copied ? <Check size={12} color="#10B981" /> : <Copy size={12} />}
          </button>
        </div>

        {msg.steps && msg.steps.length > 0 && <StepStrip steps={msg.steps} />}

        <div className="atlas-answer-body"><Markdown text={msg.text} /></div>

        {msg.executed?.map((a) => <ExecutedCard key={a.id} action={a} />)}

        {msg.proposals?.map((p) => (
          <ProposalCard key={p.id} proposal={p} decision={decisions[p.id]} busy={deciding === p.id}
            onDecide={(d) => onDecide(p.id, d)} onOpenModule={onOpenModule} />
        ))}
      </div>
    </div>
  )
}

// How the answer was reached: which parts of state were opened, what was
// attempted. Collapsed by default — available, never in the way.
function StepStrip({ steps }: { steps: AtlasStep[] }) {
  const [open, setOpen] = useState(false)
  const reads = steps.filter((s) => s.kind === 'read').length
  const acts = steps.length - reads
  return (
    <div className="atlas-steps">
      <button className="atlas-steps-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Radar size={11} />
        {reads > 0 && <span>{reads} state read{reads === 1 ? '' : 's'}</span>}
        {acts > 0 && <span>{reads > 0 ? ' · ' : ''}{acts} action{acts === 1 ? '' : 's'}</span>}
        <span className="atlas-steps-hint">how I got here</span>
      </button>
      {open && (
        <div className="atlas-steps-body">
          {steps.map((s, i) => (
            <div key={i} className={`atlas-step kind-${s.kind}`}>
              <span className="atlas-step-dot" />
              <span className="atlas-step-label">{s.label}</span>
              {s.detail && <span className="atlas-step-detail">{s.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Something ATLAS did on its own during the turn. It states the class it ran
// under, because "it just happened" is only acceptable when the operator can see
// which rule permitted it.
function ExecutedCard({ action }: { action: AtlasAction }) {
  return (
    <div className="atlas-action-card done">
      <span className="atlas-action-icon" style={{ background: '#10B98118', border: '1px solid #10B98133' }}>
        <Zap size={13} color="#10B981" />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="atlas-action-title">
          {action.label}
          <span className="atlas-action-flag done">Executed autonomously</span>
        </div>
        <div className="atlas-action-summary">{action.summary}</div>
        <div className="atlas-action-meta">
          {action.governance?.module_label && <MetaBit label="Area" value={action.governance.module_label} />}
          {action.governance?.reversibility && <MetaBit label="Reversibility" value={action.governance.reversibility} />}
          {action.governance?.blast_radius && <MetaBit label="Blast radius" value={action.governance.blast_radius} />}
          {action.governance?.reason && <MetaBit label="Policy" value={action.governance.reason} />}
        </div>
      </div>
    </div>
  )
}

// An action prepared but NOT run. This is the whole point of the tab having
// hands and a conscience at the same time: the decision is made here, with the
// same governance reasoning the approvals queue would have shown.
function ProposalCard({ proposal, decision, busy, onDecide, onOpenModule }: {
  proposal: AtlasAction
  decision?: Decision
  busy: boolean
  onDecide: (d: 'approve' | 'decline') => void
  onOpenModule?: (route: string) => void
}) {
  const g = proposal.governance ?? {}
  const tone = CLASS_TONE[g.class ?? 'human'] ?? CLASS_TONE.human
  const settled = decision?.status

  return (
    <div className={`atlas-action-card proposal${settled ? ` settled ${settled}` : ''}`}
      style={{ borderLeft: `3px solid ${settled === 'declined' ? '#64748B' : settled === 'executed' ? '#10B981' : tone.color}` }}>
      <span className="atlas-action-icon" style={{ background: `${tone.color}18`, border: `1px solid ${tone.color}33` }}>
        <tone.icon size={13} color={tone.color} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        {/* Said out loud, because the answer above it can only describe the
            decision — this card is where it is actually taken. */}
        {!settled && (
          <div className="atlas-proposal-banner">
            <span className="atlas-proposal-pulse" />
            {g.blocked ? 'Prepared — but you cannot authorise this one' : 'Awaiting your decision'}
          </div>
        )}
        <div className="atlas-action-title">
          {proposal.label}
          <span className="atlas-action-flag" style={{ color: tone.color, background: `${tone.color}16`, border: `1px solid ${tone.color}33` }}>
            {tone.label}
          </span>
          {g.blocked && <span className="atlas-action-flag blocked">Permission missing</span>}
        </div>

        <div className="atlas-action-summary">{proposal.executes}</div>

        <div className="atlas-proposal-why">
          <ShieldAlert size={11} color={tone.color} />
          <span>{g.reason || g.why_human || 'Escalated by policy.'}</span>
        </div>

        <div className="atlas-action-meta">
          {!!proposal.value_gbp && <MetaBit label="Value" value={`£${proposal.value_gbp.toLocaleString()}`} />}
          {g.module_label && <MetaBit label="Area" value={g.module_label} />}
          {g.reversibility && <MetaBit label="Reversibility" value={g.reversibility} />}
          {g.blast_radius && <MetaBit label="Blast radius" value={g.blast_radius} />}
          {g.commits_spend !== undefined && <MetaBit label="Commits spend" value={g.commits_spend ? 'Yes' : 'No'} />}
          {g.permission && <MetaBit label="Requires" value={g.permission} mono />}
        </div>

        {settled ? (
          <div className={`atlas-proposal-outcome ${settled}`}>
            {settled === 'executed' ? <Check size={12} /> : settled === 'declined' ? <X size={12} /> : <AlertTriangle size={12} />}
            <span>{decision?.summary || (settled === 'declined' ? 'Declined — nothing was changed.' : 'Done.')}</span>
            {settled === 'executed' && g.module_label && onOpenModule && (
              <button className="atlas-link-btn" onClick={() => onOpenModule(moduleRoute(g.module_label!))}>
                Open {g.module_label}
              </button>
            )}
          </div>
        ) : (
          <div className="atlas-proposal-actions">
            <button className="btn btn-sm agent-approve" disabled={busy || g.blocked} onClick={() => onDecide('approve')}
              title={g.blocked ? 'You do not hold the permission this action requires' : 'Approve and run this now'}>
              {busy ? '…' : <><Check size={12} /> Approve &amp; run</>}
            </button>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onDecide('decline')}>
              <X size={12} /> Decline
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function MetaBit({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="atlas-meta-bit">
      <span>{label}</span><b className={mono ? 'mono' : undefined}>{value}</b>
    </span>
  )
}

// The governance metadata names the module in prose; the panel navigates by route.
const ROUTES: Record<string, string> = {
  'Executive Dashboard': '/', 'Live Field Ops': '/visibility', 'Transport Control': '/transport',
  'Demand & Inventory': '/demand', 'IoT & Smart Tech': '/iot', 'Sustainability': '/sustainability',
  'Exceptions': '/exceptions', 'Scenario Simulator': '/simulator', 'Supplier & Labour Risk': '/risk',
}
const moduleRoute = (label: string) => ROUTES[label] ?? '/'
