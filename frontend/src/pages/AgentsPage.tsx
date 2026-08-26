import { useState, useCallback, useEffect, useMemo, useRef, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTheme } from '../hooks/useTheme'
import { usePermissions, permitted } from '../hooks/usePermissions'
import { AI_TABS, MASTER_AGENT } from '../lib/aiTabs'
import { AiInsightsPanel } from '../components/ui/AiInsights'
import { AskAtlas } from '../components/ui/AskAtlas'
import { timeAgo } from '../lib/insights'
import {
  fetchAgentFleet, fetchAgentRecommendations, fetchAgentActivity,
  approveRecommendation, dismissRecommendation, setAgentAutonomy,
  createWatchRule, deleteWatchRule, fetchGovernance, setAtlasModel, type AtlasModel,
} from '../lib/api'
import {
  Sparkles, Package, AlertTriangle, ShieldCheck, Truck, Cpu, Leaf, Bot,
  Activity, Lightbulb, UserCheck, Zap, Check, X, ChevronDown, ChevronRight,
  TrendingUp, TrendingDown, Minus, Clock, ArrowRight, Gauge, ShieldAlert,
  CircleDot, Radar, Plus, Trash2, MessageSquare, Wand2, ScrollText,
  Network, ListFilter, UserRound,
} from 'lucide-react'

// ─── config ─────────────────────────────────────────────────────────────────

const AGENT_ICONS: Record<string, React.ElementType> = {
  Sparkles, Package, AlertTriangle, ShieldCheck, Truck, Cpu, Leaf, Bot, Gauge, Radar,
}
const SEVERITY: Record<string, { label: string; color: string }> = {
  critical: { label: 'Critical', color: '#EF4444' }, high: { label: 'High', color: '#F97316' },
  medium: { label: 'Medium', color: '#F59E0B' }, low: { label: 'Low', color: '#64748B' },
  opportunity: { label: 'Opportunity', color: '#8B5CF6' },
}
const ACT_KIND: Record<string, { color: string; icon: React.ElementType; verb: string }> = {
  proposed: { color: '#3B82F6', icon: Lightbulb, verb: 'proposed' },
  approved: { color: '#10B981', icon: Check, verb: 'executed' },
  auto: { color: '#8B5CF6', icon: Zap, verb: 'auto-executed' },
  dismissed: { color: '#64748B', icon: X, verb: 'dismissed' },
  governance: { color: '#0EA5E9', icon: ShieldCheck, verb: 'updated' },
  // Taken straight off a module screen rather than through the queue. It is a
  // real, catalogued, governed action and belongs in the trail like any other —
  // the audit log is not "what ATLAS did", it is what was done.
  operator: { color: '#F59E0B', icon: UserRound, verb: 'actioned on the module' },
}
const AUTO_MINI: { key: 'manual' | 'semi' | 'auto'; label: string }[] = [
  { key: 'manual', label: 'M' }, { key: 'semi', label: 'S' }, { key: 'auto', label: 'A' },
]

const within24h = (iso: string) => Date.now() - new Date(iso).getTime() <= 86_400_000

// ─── main: AI Command Center panel ─────────────────────────────────────────
// Embedded as a slide-over from AppShell (not a routed page) so the agentic layer
// is reachable from anywhere without leaving the module the user is working in.

export function AiPanel({ view, onViewChange, onOpenModule, onClose, open }: {
  view: string; onViewChange: (v: string) => void; onOpenModule: (m: string) => void; onClose: () => void; open: boolean
}) {
  const { c } = useTheme()
  const { permissions } = usePermissions()
  const queryClient = useQueryClient()
  const [agentFilter, setAgentFilter] = useState('all')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const { data: fleet } = useQuery({ queryKey: ['agent-fleet'], queryFn: fetchAgentFleet, refetchInterval: 20_000, refetchOnMount: 'always' })
  const { data: recs = [] } = useQuery({
    queryKey: ['agent-recs', agentFilter],
    queryFn: () => fetchAgentRecommendations(agentFilter === 'all' ? undefined : agentFilter),
    refetchInterval: 15_000, refetchOnMount: 'always',
  })
  const { data: activity = [] } = useQuery({ queryKey: ['agent-activity'], queryFn: () => fetchAgentActivity(100), refetchInterval: 20_000 })

  // Approving an action executes it against live state (raises POs, moves stock,
  // activates plans), so every module's cached data is affected — the unkeyed
  // invalidation is deliberate and covers the agent-* keys too. The four explicit
  // calls that used to precede it were redundant work on the same caches.
  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ refetchType: 'all' })
  }, [queryClient])
  const invalidateFleet = useCallback(() => {
    ;['agent-fleet', 'agent-recs', 'agent-activity', 'agent-fleet-badge'].forEach(k => queryClient.invalidateQueries({ queryKey: [k] }))
  }, [queryClient])

  const approve = useMutation({ mutationFn: (id: string) => approveRecommendation(id), onSuccess: invalidateAll })
  const dismiss = useMutation({ mutationFn: ({ id, reason }: { id: string; reason?: string }) => dismissRecommendation(id, reason), onSuccess: invalidateAll })
  const autonomy = useMutation({ mutationFn: ({ id, level }: { id: string; level: 'manual' | 'semi' | 'auto' }) => setAgentAutonomy(id, level), onSuccess: invalidateFleet })
  const addRule = useMutation({ mutationFn: createWatchRule, onSuccess: invalidateFleet })
  const delRule = useMutation({ mutationFn: deleteWatchRule, onSuccess: invalidateFleet })
  const model = useMutation({ mutationFn: (id: string) => setAtlasModel(id), onSuccess: invalidateFleet })

  const agents: any[] = fleet?.agents ?? []
  const fleetAutonomy: string = fleet?.autonomy ?? 'auto'
  const pendingCount: number = fleet?.metrics?.pending_approvals ?? 0
  const busyId = approve.isPending ? approve.variables : dismiss.isPending ? dismiss.variables?.id : null
  const goto = onViewChange

  return (
    <div className="ai-panel-inner">
      <div className="ai-panel-topbar">
        <div className="ai-panel-topbar-head">
          <AiOrbMark size={26} />
          <div style={{ minWidth: 0 }}>
            <div className="ai-panel-rail-title">{MASTER_AGENT.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: c.textMuted }}>{MASTER_AGENT.role}</span>
              <AutonomyPill level={fleetAutonomy} compact />
            </div>
          </div>
        </div>
        <div className="ai-panel-tabs">
          {AI_TABS.map((tab) => {
            const active = view === tab.id
            return (
              <button key={tab.id} data-tour={`ai-tab-${tab.id}`} className={`ai-panel-tab${active ? ' active' : ''}`} onClick={() => goto(tab.id)}>
                <tab.icon size={15} strokeWidth={1.9} />
                <span>{tab.label}</span>
                {tab.badge === 'approvals' && pendingCount > 0 && <span className="badge">{pendingCount}</span>}
              </button>
            )
          })}
        </div>

        {/* Which model ATLAS reasons with. It sits in the command bar rather than
            buried in Governance because it changes the quality and cost of every
            answer and every autonomous decision — it is an operating choice, not
            a setting you configure once. */}
        {fleet?.llm?.enabled && (
          <ModelPicker models={fleet.llm.models ?? []}
            onSelect={(id) => model.mutate(id)} switching={model.isPending ? model.variables : null} />
        )}
      </div>

      {/* The chat owns its own scrolling — a thread that scrolls the whole panel
          would push its own composer off the bottom of the screen. */}
      <div className={`ai-panel-content${view === 'ask' ? ' ai-panel-content-chat' : ''}`}>
        {view === 'overview' && <OverviewTab fleet={fleet} recs={recs} activity={activity} goto={goto} openModule={onOpenModule} />}

        {view === 'approvals' && (
          <ApprovalsTab agents={agents} recs={recs} agentFilter={agentFilter} setAgentFilter={setAgentFilter}
            permissions={permissions} busyId={busyId}
            onApprove={(id) => approve.mutate(id)} onDismiss={(id, reason) => dismiss.mutate({ id, reason })}
            onOpenModule={onOpenModule} />
        )}

        {view === 'automated' && <AutomatedTab activity={activity} metrics={fleet?.metrics} />}

        {view === 'agents' && (
          <AgentsTab agents={agents} onAutonomy={(id, lvl) => autonomy.mutate({ id, level: lvl })} onFilter={(id) => { setAgentFilter(id); goto('approvals') }} />
        )}

        {view === 'audit' && <AuditTab activity={activity} agents={agents} />}

        {view === 'ask' && (
          <AskAtlas llmEnabled={!!fleet?.llm?.enabled} model={fleet?.llm?.model_label ?? fleet?.llm?.model}
            onStateChanged={invalidateAll} onOpenModule={onOpenModule} />
        )}

        {view === 'governance' && (
          <GovernanceTab fleet={fleet}
            onCreateRule={(r: any) => addRule.mutate(r)} onDeleteRule={(id: string) => delRule.mutate(id)} creatingRule={addRule.isPending} />
        )}
      </div>
    </div>
  )
}

// ─── model picker ─────────────────────────────────────────────────────────────
// The order is the order the models are offered in; the active one is marked
// rather than merely highlighted, because on a narrow panel the button collapses
// to an icon and the menu becomes the only place the choice is legible.
//
// Models arrive already filtered to the providers this deployment holds a key
// for, so the menu never offers something that would fail. They are grouped
// under the provider serving them because that is what an operator is choosing
// between once OpenRouter is wired up — the same Gemini model is reachable both
// ways, and which key pays for it is the distinction the label carries.

function ModelPicker({ models, onSelect, switching }: {
  models: AtlasModel[]; onSelect: (id: string) => void; switching: string | null
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = models.find((m) => m.active)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open])

  // Grouped in the order the providers first appear, so the backend keeps
  // control of precedence and the menu never reshuffles under the operator.
  const groups = useMemo(() => {
    const out: { provider: string; label: string; models: AtlasModel[] }[] = []
    for (const m of models) {
      const bucket = out.find((g) => g.provider === m.provider)
      if (bucket) bucket.models.push(m)
      else out.push({ provider: m.provider, label: m.provider_label || m.provider, models: [m] })
    }
    return out
  }, [models])

  if (models.length === 0) return null

  return (
    <div className="model-picker" ref={ref}>
      <button className={`model-picker-btn${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox" aria-expanded={open}
        title={`Reasoning model — ${active?.label ?? 'select'}${active ? ` (${active.provider_label})` : ''}`}>
        <Sparkles size={12} />
        <span className="model-picker-label">{active?.label ?? 'Select model'}</span>
        <ChevronDown size={12} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .16s' }} />
      </button>

      {open && (
        <div className="model-menu" role="listbox">
          <div className="model-menu-head">Reasoning model</div>
          <div className="model-menu-scroll">
            {groups.map((g) => (
              <div key={g.provider} role="group" aria-label={g.label}>
                {/* Only worth a divider when there is more than one place to
                    route to — a single-provider deployment reads as one list. */}
                {groups.length > 1 && <div className="model-menu-group">{g.label}</div>}
                {g.models.map((m) => (
                  <button key={m.id} role="option" aria-selected={m.active}
                    className={`model-menu-item${m.active ? ' active' : ''}`}
                    disabled={!!switching}
                    onClick={() => { if (!m.active) onSelect(m.id); setOpen(false) }}>
                    <span className="model-menu-check">
                      {switching === m.id ? <span className="model-menu-spin" /> : m.active ? <Check size={12} /> : null}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span className="model-menu-label">{m.label}</span>
                      <span className="model-menu-blurb">{m.blurb}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="model-menu-foot">
            Applies to the next question · remembered across restarts
          </div>
        </div>
      )}
    </div>
  )
}

// Small reusable orb mark — the panel's own identity badge, matching the FAB in AppShell.
export function AiOrbMark({ size = 22 }: { size?: number }) {
  return (
    <span className="ai-orb-mark" style={{ width: size, height: size }}>
      <span className="ai-orb-ring" />
      <Sparkles size={size * 0.5} strokeWidth={2.2} />
    </span>
  )
}

// ─── TAB: Command Center (AI insights on current state) ───────────────────────

function OverviewTab({ fleet, recs, activity, goto, openModule }: { fleet: any; recs: any[]; activity: any[]; goto: (v: string) => void; openModule: (m: string) => void }) {
  const { c } = useTheme()
  const metrics = fleet?.metrics
  const agents: any[] = (fleet?.agents ?? []).filter((a: any) => a.id !== 'orchestrator')
  const llm = fleet?.llm
  const autoRecent = activity.filter((e) => e.kind === 'auto' && within24h(e.ts)).slice(0, 4)
  const topEsc = recs.slice(0, 4)

  return (
    <>
      {/* Insight hero */}
      <div className="agent-hero" style={{ background: `linear-gradient(135deg, ${c.surface} 0%, ${c.surfaceSubtle} 100%)`, border: `1px solid ${c.border}` }}>
        <div className="agent-hero-main">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span className="agent-hero-badge"><Bot size={16} /></span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: c.textPrimary, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                {MASTER_AGENT.name}
                <span className="agent-live"><span className="agent-live-dot" /> Autonomous</span>
                {llm?.enabled && <span className="gemini-chip"><Sparkles size={10} /> {llm.model}</span>}
              </div>
              <div style={{ fontSize: 11, color: c.textMuted }}>{MASTER_AGENT.role} · insight on the current state of your network — no module drilling required</div>
            </div>
          </div>
          <div style={{ fontSize: 13.5, color: c.textSecondary, lineHeight: 1.6 }}>{fleet?.briefing?.headline ?? 'Reading the control tower…'}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" onClick={() => goto('approvals')}><UserCheck size={13} /> Review approvals ({metrics?.pending_approvals ?? 0})</button>
            <button className="btn btn-secondary btn-sm" onClick={() => goto('automated')}><Zap size={13} /> What I did (24h)</button>
            <button className="btn btn-secondary btn-sm" onClick={() => goto('ask')}><MessageSquare size={13} /> Ask {MASTER_AGENT.name}</button>
          </div>
        </div>
      </div>

      {/* AI Insights & Recommendations — moved here from the Executive Dashboard.
          It sits directly under the hero because the two answer consecutive
          questions: the hero says what ATLAS is doing about the network, and this
          gives the full state of play — what the network's state means, what
          ATLAS has already executed about it, and what it is holding for a human.
          `goto` is threaded in so its ledger can hand off into the Automated and
          Approvals tabs rather than dead-ending on a count. */}
      <AiInsightsPanel onOpenModule={openModule} onOpenView={goto} />

      {/* Metrics */}
      <div className="agent-metrics" style={{ marginTop: 18 }}>
        <MetricTile icon={Radar} label="Capabilities engaged" value={`${metrics?.agents_engaged ?? 0}/${metrics?.agents_total ?? 8}`} accent="#8B5CF6" />
        <MetricTile icon={Lightbulb} label="Awaiting you" value={metrics?.pending_approvals ?? 0} accent="#3B82F6" />
        <MetricTile icon={ShieldAlert} label="Critical / high" value={metrics?.critical_pending ?? 0} accent="#EF4444" />
        <MetricTile icon={Zap} label="Auto-run today" value={metrics?.auto_executed_today ?? 0} accent="#F59E0B" />
        <MetricTile icon={Check} label="Actioned today" value={metrics?.actions_executed_today ?? 0} accent="#10B981" />
        <MetricTile icon={Activity} label="Signals watched" value={metrics?.signals_monitored ?? 0} accent="#0EA5E9" />
      </div>

      {/* Network status by domain — each tile launches the live module (AI mode travels with you) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 2px 12px' }}>
        <Network size={15} color={c.textSecondary} />
        <span style={{ fontSize: 13, fontWeight: 800, color: c.textPrimary }}>Network status by domain</span>
        <span style={{ fontSize: 11, color: c.textMuted, fontWeight: 500 }}>· open a domain to work in its live module</span>
        <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto', padding: '2px 9px' }} onClick={() => goto('agents')}>Capabilities <ArrowRight size={12} /></button>
      </div>
      <div className="domain-grid">
        {agents.map((a) => <DomainTile key={a.id} agent={a} onClick={() => openModule(a.module)} />)}
      </div>

      {/* Split: approvals preview + automated preview */}
      <div className="grid-2" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <UserCheck size={14} color="#3B82F6" /><span className="card-title">Needs your approval</span>
            <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto', padding: '2px 9px' }} onClick={() => goto('approvals')}>View all <ArrowRight size={12} /></button>
          </div>
          {topEsc.length === 0
            ? <div className="card-body" style={{ fontSize: 12, color: c.textMuted, textAlign: 'center', padding: '22px' }}>Nothing escalated — it's under control.</div>
            : topEsc.map((r) => <MiniRow key={r.id} accent={SEVERITY[r.severity]?.color} icon={Bot} title={r.title} sub={r.module_label ? `${r.module_label} · ${SEVERITY[r.severity]?.label}` : SEVERITY[r.severity]?.label} />)}
        </div>
        <div className="card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Zap size={14} color="#8B5CF6" /><span className="card-title">Automated in last 24h</span>
            <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto', padding: '2px 9px' }} onClick={() => goto('automated')}>View all <ArrowRight size={12} /></button>
          </div>
          {autoRecent.length === 0
            ? <div className="card-body" style={{ fontSize: 12, color: c.textMuted, textAlign: 'center', padding: '22px' }}>No automated actions in the last 24h.</div>
            : autoRecent.map((e, i) => <MiniRow key={i} accent="#8B5CF6" icon={Zap} title={e.title} sub={e.module_label ? `${e.module_label} · ${timeAgo(e.ts)}` : timeAgo(e.ts)} />)}
        </div>
      </div>
    </>
  )
}

function DomainTile({ agent, onClick }: { agent: any; onClick: () => void }) {
  const { c } = useTheme()
  const Icon = AGENT_ICONS[agent.icon] ?? Bot
  const st = STATUS_CFG[agent.status] ?? STATUS_CFG.monitoring
  const trust = agent.trust ?? { score: 72 }
  return (
    <button className="domain-tile" onClick={onClick} style={{ background: c.surface, border: `1px solid ${c.border}`, borderTop: `2px solid ${agent.accent}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, background: `${agent.accent}18`, border: `1px solid ${agent.accent}33`, flexShrink: 0 }}><Icon size={15} color={agent.accent} /></span>
        <div style={{ minWidth: 0, textAlign: 'left' }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: c.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</div>
          <div style={{ fontSize: 11, color: c.textMuted }}>{agent.module_label}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: st.color }}><CircleDot size={9} /> {st.label}</span>
        {agent.pending_count > 0 && <span style={{ fontSize: 11, fontWeight: 800, color: c.textSecondary, background: c.surfaceMuted, border: `1px solid ${c.border}`, borderRadius: 8, padding: '0 6px', marginLeft: 'auto' }}>{agent.pending_count}</span>}
      </div>
    </button>
  )
}

function MiniRow({ accent, icon: Icon, title, sub }: { accent: string; icon: React.ElementType; title: string; sub: string }) {
  const { c } = useTheme()
  return (
    <div style={{ display: 'flex', gap: 10, padding: '10px 14px', borderTop: `1px solid ${c.borderSubtle}`, alignItems: 'center' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, background: `${accent}18`, border: `1px solid ${accent}33`, flexShrink: 0 }}><Icon size={13} color={accent} /></span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: c.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
        <div style={{ fontSize: 11, color: c.textMuted }}>{sub}</div>
      </div>
    </div>
  )
}

// ─── TAB: Approvals ───────────────────────────────────────────────────────────
// A decision queue, not a card wall. Approvals are a triage job: the operator
// needs to scan many rows fast, compare them on the same axes (severity, value,
// confidence, how long it has been waiting), act on several at once, and be able
// to open the full reasoning for any one of them without losing the queue.
//
// Table conventions applied throughout:
//   · one row per decision, sortable on every column that means anything
//   · numerics right-aligned and tabular so magnitudes line up down the column
//   · severity carried by an accent bar AND a text label (never colour alone)
//   · sticky header, so the columns stay readable while scrolling
//   · the primary action lives in the row; the reasoning lives one click deeper
//   · bulk select for the routine tail, hard-blocked where policy forbids it
//   · selection state, filters and sort survive a background refetch

const SORTABLE: { key: string; label: string; align?: 'right'; width?: number }[] = [
  { key: 'severity',   label: 'Severity', width: 104 },
  { key: 'title',      label: 'Decision' },
  { key: 'module',     label: 'Area', width: 150 },
  { key: 'value',      label: 'Value', align: 'right', width: 92 },
  { key: 'confidence', label: 'Confidence', align: 'right', width: 118 },
  { key: 'consensus',  label: 'Consensus', align: 'right', width: 104 },
  { key: 'policy',     label: 'Why you', width: 150 },
  { key: 'age',        label: 'Waiting', align: 'right', width: 86 },
]

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, opportunity: 4 }
const gbp = (n: number) => (n ? `£${n >= 1000 ? `${Math.round(n / 1000)}k` : n}` : '—')

function ApprovalsTab({ agents, recs, agentFilter, setAgentFilter, permissions, busyId, onApprove, onDismiss, onOpenModule }: {
  agents: any[]; recs: any[]; agentFilter: string; setAgentFilter: (v: string) => void; permissions: string[]
  busyId: any; onApprove: (id: string) => void; onDismiss: (id: string, reason?: string) => void; onOpenModule: (m: string) => void
}) {
  const { c } = useTheme()
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'severity', dir: 1 })
  const [sevFilter, setSevFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dismissing, setDismissing] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  const canApproveRec = useCallback((r: any) =>
    !r.action?.requires_permission || permitted(permissions, r.action.requires_permission), [permissions])

  const rows = recs
    .filter((r) => sevFilter === 'all' || r.severity === sevFilter)
    .filter((r) => !query || `${r.title} ${r.module_label} ${r.summary}`.toLowerCase().includes(query.toLowerCase()))
  const sorted = [...rows].sort((a, b) => {
    const get = (r: any) => ({
      severity: SEV_ORDER[r.severity] ?? 9,
      title: r.title?.toLowerCase() ?? '',
      module: r.module_label ?? '',
      value: -(r.value_gbp ?? 0),
      confidence: -(r.confidence ?? 0),
      consensus: -(r.consensus ?? 0),
      policy: r.policy_autonomy ?? '',
      age: -new Date(r.created_at ?? 0).getTime(),
    }[sort.key] as any)
    const [x, y] = [get(a), get(b)]
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
  })

  // Selection is only ever offered where a bulk approval is actually permitted:
  // the policy blocks bulk on critical rows and above the dual-control line.
  const bulkable = sorted.filter((r) => canApproveRec(r) && r.severity !== 'critical' && !r.governance?.dual_control)
  const selectedRows = sorted.filter((r) => selected.has(r.id))
  const selectedValue = selectedRows.reduce((s, r) => s + (r.value_gbp ?? 0), 0)
  const bulkBlocked = selectedValue >= 100_000
  const allBulkSelected = bulkable.length > 0 && bulkable.every((r) => selected.has(r.id))

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n
  })
  const sortBy = (key: string) => setSort((s) => s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 })

  const counts = { critical: 0, high: 0, medium: 0, low: 0, opportunity: 0 } as Record<string, number>
  recs.forEach((r) => { counts[r.severity] = (counts[r.severity] ?? 0) + 1 })
  const totalValue = recs.reduce((s, r) => s + (r.value_gbp ?? 0), 0)
  // Decisions and items are different numbers and both matter: the queue is
  // eleven decisions, but those decisions commit seventy-one orders. Reporting
  // only one of them would misrepresent the workload or the exposure.
  const itemCount = recs.reduce((s, r) => s + (r.batch?.count ?? 1), 0)

  return (
    <>
      {/* Queue summary — what is waiting, how severe, how much is riding on it.
          This is the WHOLE queue, not a page of it: the counts and the value
          below are the real backlog, so working the queue empties it. */}
      <div className="approval-summary">
        <SummaryStat label="Decisions awaiting you" value={recs.length} accent="#3B82F6" icon={UserCheck}
          sub={itemCount !== recs.length ? `${itemCount} items` : undefined} />
        <SummaryStat label="Critical / high" value={(counts.critical ?? 0) + (counts.high ?? 0)} accent="#EF4444" icon={ShieldAlert} />
        <SummaryStat label="Value at stake" value={gbp(totalValue)} accent="#F59E0B" icon={Gauge} />
        <SummaryStat label="Oldest" value={recs.length ? timeAgo([...recs].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))[0].created_at) : '—'} accent="#8B5CF6" icon={Clock} />
      </div>

      {/* Filters — area, severity, free text. Kept above the table so the header row stays sticky. */}
      <div className="approval-toolbar">
        <div className="agent-chips">
          <FilterChip active={agentFilter === 'all'} onClick={() => setAgentFilter('all')} label="All areas" />
          {agents.filter(a => a.id !== 'orchestrator').map((a) => (
            <FilterChip key={a.id} active={agentFilter === a.id} onClick={() => setAgentFilter(a.id)} label={a.module_label ?? a.name} icon={AGENT_ICONS[a.icon]} accent={a.accent} count={a.pending_count} />
          ))}
        </div>
        <div className="approval-toolbar-right">
          <select value={sevFilter} onChange={(e) => setSevFilter(e.target.value)} style={selStyle(c)} aria-label="Filter by severity">
            <option value="all">All severities</option>
            {Object.keys(SEVERITY).map((s) => <option key={s} value={s}>{SEVERITY[s].label} ({counts[s] ?? 0})</option>)}
          </select>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search decisions…"
            aria-label="Search the approval queue" style={{ ...selStyle(c), minWidth: 190 }} />
        </div>
      </div>

      {/* Bulk action bar — only appears when something is selected, and states its own limits */}
      {selected.size > 0 && (
        <div className={`approval-bulkbar${bulkBlocked ? ' blocked' : ''}`}>
          <span className="approval-bulkbar-count">{selected.size} selected · {gbp(selectedValue)}</span>
          {bulkBlocked
            ? <span className="approval-bulkbar-warn"><ShieldAlert size={13} /> Bulk approval is blocked above £100k combined — approve these individually.</span>
            : <span className="approval-bulkbar-hint">Critical rows and dual-control actions are never bulk-approvable.</span>}
          <button className="btn btn-secondary btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
          <button className="btn btn-sm agent-approve" disabled={bulkBlocked}
            onClick={() => { selectedRows.forEach((r) => onApprove(r.id)); setSelected(new Set()) }}>
            <Check size={13} /> Approve {selected.size}
          </button>
        </div>
      )}

      {recs.length === 0 ? (
        <div className="card"><div className="empty-state" style={{ padding: '48px 20px' }}>
          <div style={{ color: 'var(--status-success-text)', marginBottom: 10 }}><ShieldCheck size={40} /></div>
          <div style={{ fontWeight: 700, color: c.textPrimary }}>Nothing needs your approval</div>
          <div style={{ fontSize: 12, color: c.textMuted, marginTop: 4 }}>Routine actions self-execute within guardrails. High-stakes decisions appear here.</div>
        </div></div>
      ) : (
        <div className="card approval-table-card">
          <div className="approval-table-scroll">
            <table className="data-table approval-table">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>
                    <input type="checkbox" checked={allBulkSelected} aria-label="Select all bulk-approvable rows"
                      onChange={() => setSelected(allBulkSelected ? new Set() : new Set(bulkable.map((r) => r.id)))} />
                  </th>
                  {SORTABLE.map((col) => (
                    <th key={col.key} style={{ width: col.width, textAlign: col.align ?? 'left', cursor: 'pointer' }}
                      onClick={() => sortBy(col.key)}
                      aria-sort={sort.key === col.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                      <span className="th-sort">{col.label}{sort.key === col.key && <ChevronDown size={11} style={{ transform: sort.dir === -1 ? 'rotate(180deg)' : undefined }} />}</span>
                    </th>
                  ))}
                  <th style={{ width: 178, textAlign: 'right' }}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const sev = SEVERITY[r.severity] ?? SEVERITY.medium
                  const allowed = canApproveRec(r)
                  const isOpen = expanded === r.id
                  const busy = busyId === r.id
                  return (
                    <Fragment key={r.id}>
                      <tr className={`approval-row${isOpen ? ' expanded' : ''}`}>
                        <td>
                          <input type="checkbox" checked={selected.has(r.id)} disabled={!bulkable.includes(r)}
                            aria-label={`Select ${r.title}`} onChange={() => toggle(r.id)} />
                        </td>
                        <td>
                          <span className="sev-chip" style={{ color: sev.color, background: `${sev.color}18`, border: `1px solid ${sev.color}3a` }}>
                            <span className="sev-dot" style={{ background: sev.color }} />{sev.label}
                          </span>
                        </td>
                        <td>
                          <button className="approval-title" onClick={() => setExpanded(isOpen ? null : r.id)}
                            aria-expanded={isOpen} title="Show the reasoning behind this decision">
                            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            <span>
                              <span className="approval-title-main">
                                {r.title}
                                {r.batch && <span className="batch-badge" title={`${r.batch.count} items decided together — expand to see every line`}>{r.batch.count} items</span>}
                              </span>
                              <span className="approval-title-sub">{r.governance?.tab ?? r.section ?? '—'} · {r.action?.label}</span>
                            </span>
                          </button>
                        </td>
                        <td><span className="approval-module" style={{ borderLeft: `2px solid ${r.agent_accent}` }}>{r.module_label}</span></td>
                        <td className="num">{gbp(r.value_gbp)}</td>
                        <td className="num"><ConfidenceMeter value={r.confidence} color={r.agent_accent} /></td>
                        <td className="num"><ConsensusPip score={r.consensus} objections={r.objections} /></td>
                        <td><PolicyChip rec={r} /></td>
                        <td className="num" title={new Date(r.created_at).toLocaleString('en-GB')}>{timeAgo(r.created_at)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {dismissing === r.id ? (
                            <div className="approval-dismiss">
                              <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
                                placeholder="Reason — logged" style={selStyle(c)} />
                              <button className="btn btn-sm" style={{ background: '#64748B', color: '#fff', border: 'none' }}
                                onClick={() => { onDismiss(r.id, reason || undefined); setDismissing(null); setReason('') }}>OK</button>
                              <button className="btn btn-secondary btn-sm" onClick={() => setDismissing(null)}>×</button>
                            </div>
                          ) : (
                            <div className="approval-actions">
                              <button className="btn btn-sm agent-approve" disabled={!allowed || busy}
                                onClick={() => onApprove(r.id)}
                                title={allowed ? r.action?.executes : `You lack ${r.action?.requires_permission}`}>
                                {busy ? '…' : <><Check size={12} /> Approve</>}
                              </button>
                              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setDismissing(r.id)} title="Dismiss with a reason">
                                <X size={12} />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="approval-detail-row">
                          <td colSpan={SORTABLE.length + 2}>
                            <ApprovalDetail rec={r} onOpenModule={() => onOpenModule(r.module)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="approval-table-foot">
            Showing {sorted.length} of {recs.length} decision{recs.length !== 1 ? 's' : ''}
            {sevFilter !== 'all' || query ? ' (filtered)' : ''} · click a decision to see how ATLAS reached it
          </div>
        </div>
      )}
    </>
  )
}

function SummaryStat({ label, value, accent, icon: Icon, sub }: {
  label: string; value: any; accent: string; icon: React.ElementType; sub?: string
}) {
  const { c } = useTheme()
  return (
    <div className="approval-stat" style={{ background: c.surface, border: `1px solid ${c.border}`, borderTop: `2px solid ${accent}` }}>
      <span className="approval-stat-icon" style={{ background: `${accent}18`, border: `1px solid ${accent}33` }}><Icon size={13} color={accent} /></span>
      <div>
        <div className="approval-stat-value">
          {value}{sub && <span className="approval-stat-sub"> · {sub}</span>}
        </div>
        <div className="approval-stat-label">{label}</div>
      </div>
    </div>
  )
}

// Consensus at a glance — how much of the round table backed this, and whether
// anyone objected. An objection is the single most important thing on the row
// after severity, so it gets its own mark rather than hiding inside the number.
function ConsensusPip({ score = 0, objections = 0 }: { score?: number; objections?: number }) {
  const { c } = useTheme()
  const col = objections ? '#EF4444' : score >= 85 ? '#10B981' : score >= 60 ? '#F59E0B' : '#F97316'
  return (
    <span className="consensus-pip" title={objections ? `${objections} capability objected` : `${score}% of the round table supported this`}>
      {objections > 0 && <ShieldAlert size={11} color="#EF4444" />}
      <span style={{ color: col, fontWeight: 800 }}>{score}%</span>
      <span style={{ color: c.textMuted, fontSize: 11 }}>{objections ? 'contested' : ''}</span>
    </span>
  )
}

// The expanded row: why it exists, what it will do, and the full decision stack.
function ApprovalDetail({ rec, onOpenModule }: { rec: any; onOpenModule: () => void }) {
  const { c } = useTheme()
  const g = rec.governance ?? {}
  return (
    <div className="approval-detail">
      <div className="approval-detail-grid">
        <div>
          <DetailHeading>Why this is in front of you</DetailHeading>
          <p className="approval-detail-text">{g.why_human || g.approval_trigger || 'Escalated by policy.'}</p>
          <div className="approval-detail-meta">
            <MetaPill label="Class" value={g.class === 'dual' ? 'Dual control' : g.class === 'human' ? 'Human decision' : 'Autonomous'} />
            <MetaPill label="Reversibility" value={g.reversibility ?? '—'} />
            <MetaPill label="Blast radius" value={g.blast_radius ?? '—'} />
            {g.sla_minutes ? <MetaPill label="Target" value={g.sla_minutes >= 60 ? `${Math.round(g.sla_minutes / 60)}h` : `${g.sla_minutes}m`} /> : null}
            <MetaPill label="Commits spend" value={g.commits_spend ? 'Yes' : 'No'} />
          </div>
        </div>
        <div>
          <DetailHeading>What runs on approval</DetailHeading>
          <p className="approval-detail-text">{rec.action?.executes}</p>
          {rec.action?.requires_permission && (
            <div className="approval-detail-perm"><ShieldCheck size={11} /> Requires <code>{rec.action.requires_permission}</code></div>
          )}
          <button onClick={onOpenModule} className="agent-expand" style={{ marginTop: 8, color: rec.agent_accent, border: `1px solid ${rec.agent_accent}40`, background: `${rec.agent_accent}10` }}>
            Open {rec.module_label} <ArrowRight size={12} />
          </button>
        </div>
      </div>

      <DetailHeading>The case</DetailHeading>
      <p className="approval-detail-text">{rec.summary}</p>
      <div className="approval-detail-chips">
        {(rec.evidence ?? []).map((e: any, i: number) => (
          <span key={i} title={e.detail} className="evidence-chip" style={{ background: c.surfaceSubtle, border: `1px solid ${c.border}` }}>
            <span style={{ color: c.textMuted }}>{e.label}</span><b style={{ color: c.textPrimary }}>{e.value}</b>
          </span>
        ))}
        {(rec.projected_impact ?? []).map((imp: any, i: number) => <ImpactPill key={`i${i}`} imp={imp} />)}
      </div>

      {/* A grouped decision must itemise itself. Approving this row commits every
          line below, so every line is shown — grouping is there to make the
          decision proportionate, never to hide what it commits. */}
      {rec.batch && (
        <>
          <DetailHeading>
            What approving this commits · {rec.batch.count} line{rec.batch.count === 1 ? '' : 's'} · £{rec.batch.total_gbp.toLocaleString()}
          </DetailHeading>
          <div className="batch-lines">
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th><th>Description</th>
                  <th style={{ textAlign: 'right', width: 74 }}>Qty</th>
                  <th style={{ textAlign: 'right', width: 74 }}>Cover</th>
                  <th style={{ textAlign: 'right', width: 92 }}>Value</th>
                  <th style={{ width: 88 }}>Supplier</th>
                </tr>
              </thead>
              <tbody>
                {rec.batch.lines.map((l: any) => (
                  <tr key={l.sku_code}>
                    <td className="mono">{l.sku_code}</td>
                    <td>{l.description}</td>
                    <td className="num">{l.quantity?.toLocaleString()}</td>
                    <td className="num">{l.days_of_supply != null ? `${l.days_of_supply}d` : '—'}</td>
                    <td className="num">£{l.value_gbp?.toLocaleString()}</td>
                    <td>{l.supplier_code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {rec.trace && <TraceView trace={rec.trace} />}
    </div>
  )
}

function DetailHeading({ children }: { children: React.ReactNode }) {
  return <div className="approval-detail-heading">{children}</div>
}

function MetaPill({ label, value }: { label: string; value: string }) {
  const { c } = useTheme()
  return (
    <span className="meta-pill" style={{ background: c.surfaceSubtle, border: `1px solid ${c.border}` }}>
      <span style={{ color: c.textMuted }}>{label}</span><b style={{ color: c.textPrimary }}>{value}</b>
    </span>
  )
}

// ─── Reasoning trace ──────────────────────────────────────────────────────────
// The stack behind an action. Four views of the same decision, because different
// questions need different shapes: "what did it look at" (signals), "what did it
// conclude" (reasoning), "did anything disagree" (negotiation) and "why was I
// asked" (policy gates). The raw call stack is kept as a fifth view for anyone
// who wants the unabridged version.

const TRACE_VIEWS = [
  { id: 'reasoning',   label: 'Reasoning',    icon: Lightbulb },
  { id: 'negotiation', label: 'Negotiation',  icon: Network },
  { id: 'policy',      label: 'Policy gates', icon: ShieldCheck },
  { id: 'stack',       label: 'Call stack',   icon: ScrollText },
]

export function TraceView({ trace, compact }: { trace: any; compact?: boolean }) {
  const { c } = useTheme()
  const [view, setView] = useState('reasoning')
  const [open, setOpen] = useState(!compact)
  if (!trace) return null
  const dec = trace.decision ?? {}
  const arb = trace.arbitration ?? {}
  const outcome = dec.outcome ?? 'escalate_for_approval'
  const outColor = outcome.startsWith('auto') ? '#10B981' : outcome === 'human_overrode' ? '#64748B' : '#8B5CF6'

  return (
    <div className="trace" style={{ border: `1px solid ${c.border}`, background: c.surfaceSubtle }}>
      <button className="trace-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Radar size={13} color="#8B5CF6" />
        <span className="trace-head-title">Reasoning trace</span>
        <code className="trace-id">{trace.trace_id}</code>
        <span className="trace-head-meta">
          {trace.signals?.length ?? 0} signals · {trace.negotiation?.length ?? 0} capabilities · {arb.consensus_score ?? 0}% consensus
          {arb.objections > 0 && <b style={{ color: 'var(--status-danger-text)' }}> · {arb.objections} objection{arb.objections !== 1 ? 's' : ''}</b>}
        </span>
        <span className="trace-outcome" style={{ color: outColor, background: `${outColor}18`, border: `1px solid ${outColor}3a` }}>
          {String(outcome).replace(/_/g, ' ')}
        </span>
      </button>

      {open && (
        <>
          <div className="trace-tabs">
            {TRACE_VIEWS.map((v) => (
              <button key={v.id} className={`trace-tab${view === v.id ? ' active' : ''}`} onClick={() => setView(v.id)}>
                <v.icon size={12} /> {v.label}
              </button>
            ))}
            <span className="trace-elapsed"><Clock size={10} /> {trace.deliberation_ms}ms</span>
          </div>

          <div className="trace-body">
            {view === 'reasoning' && (
              <>
                <TraceSectionLabel>Sensed — {trace.signals?.length ?? 0} live signal(s)</TraceSectionLabel>
                <div className="trace-signals">
                  {(trace.signals ?? []).map((s: any, i: number) => (
                    <span key={i} className="evidence-chip" title={s.detail || s.source} style={{ background: c.surface, border: `1px solid ${c.border}` }}>
                      <span style={{ color: c.textMuted }}>{s.label}</span><b style={{ color: c.textPrimary }}>{String(s.value)}</b>
                    </span>
                  ))}
                </div>
                <TraceSectionLabel>Reasoned</TraceSectionLabel>
                <ol className="trace-steps">
                  {(trace.reasoning ?? []).map((r: any, i: number) => (
                    <li key={i}>
                      <div className="trace-step-inference">{r.inference}</div>
                      <div className="trace-step-meta"><b>rule</b> {r.rule}</div>
                      {r.observation && <div className="trace-step-meta"><b>observed</b> {r.observation}</div>}
                    </li>
                  ))}
                </ol>
                {(trace.alternatives ?? []).length > 0 && (
                  <>
                    <TraceSectionLabel>Alternatives weighed</TraceSectionLabel>
                    {trace.alternatives.map((a: any, i: number) => (
                      <div key={i} className="trace-alt">
                        <div className="trace-alt-option"><Minus size={11} color={c.textMuted} /> {a.option}</div>
                        <div className="trace-step-meta"><b>projected</b> {a.projected}</div>
                        <div className="trace-step-meta"><b>rejected</b> {a.rejected_because}</div>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}

            {view === 'negotiation' && (
              <>
                <TraceSectionLabel>Round table — each capability answered for its own domain</TraceSectionLabel>
                <div className="trace-table">
                  {(trace.negotiation ?? []).map((p: any, i: number) => (
                    <div key={i} className="trace-voice" style={{ borderLeft: `3px solid ${p.stance_color}` }}>
                      <div className="trace-voice-head">
                        <span className="trace-stance" style={{ color: p.stance_color, background: `${p.stance_color}18`, border: `1px solid ${p.stance_color}3a` }}>
                          {p.stance_label}
                        </span>
                        <b style={{ color: c.textPrimary }}>{p.name}</b>
                        <span style={{ color: c.textMuted, fontSize: 11 }}>{p.role}</span>
                        {p.blocking && <span className="trace-blocking"><ShieldAlert size={10} /> blocking</span>}
                      </div>
                      <div className="trace-voice-arg">{p.argument}</div>
                      {(p.evidence ?? []).length > 0 && (
                        <div className="trace-voice-ev">
                          {p.evidence.map((e: any, j: number) => (
                            <span key={j} className="evidence-chip" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
                              <span style={{ color: c.textMuted }}>{e.label}</span><b style={{ color: c.textPrimary }}>{String(e.value)}</b>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <TraceSectionLabel>Arbitration — how ATLAS settled it</TraceSectionLabel>
                <div className="trace-arb">
                  <div className="trace-arb-score">
                    <div className="trace-arb-bar"><div style={{ width: `${arb.consensus_score ?? 0}%`, background: (arb.objections ? '#EF4444' : '#10B981') }} /></div>
                    <b>{arb.consensus_score ?? 0}%</b> consensus
                    <span style={{ color: c.textMuted }}>
                      {arb.supporting ?? 0} support · {arb.conditional ?? 0} conditional · {arb.cautions ?? 0} caution · {arb.objections ?? 0} object
                    </span>
                  </div>
                  <div className="trace-step-meta"><b>rule</b> {arb.rule}</div>
                  <div className="trace-arb-summary">{arb.summary}</div>
                  {(dec.conditions ?? []).length > 0 && (
                    <div className="trace-conditions">
                      <b>Conditions carried forward</b>
                      <ul>{dec.conditions.map((cd: string, i: number) => <li key={i}>{cd}</li>)}</ul>
                    </div>
                  )}
                </div>
              </>
            )}

            {view === 'policy' && (
              <>
                <TraceSectionLabel>Governance gates — every check, with the number it was measured against</TraceSectionLabel>
                <table className="data-table trace-gates">
                  <thead><tr><th style={{ width: 60 }}>Result</th><th>Gate</th><th>Required</th><th>Actual</th><th>Why it exists</th></tr></thead>
                  <tbody>
                    {(trace.policy?.gates ?? []).map((g: any, i: number) => (
                      <tr key={i}>
                        <td><span className={`gate-badge ${g.pass ? 'pass' : 'fail'}`}>{g.pass ? 'PASS' : 'FAIL'}</span></td>
                        <td><b>{g.gate}</b></td>
                        <td className="mono">{g.requirement}</td>
                        <td className="mono">{g.actual}</td>
                        <td style={{ color: c.textMuted, fontSize: 11 }}>{g.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {view === 'stack' && (
              <pre className="trace-stack">
                {(trace.frames ?? []).map((f: any) => (
                  <div key={f.seq} className={`trace-frame kind-${f.kind}`} style={{ paddingLeft: 8 + f.depth * 18 }}>
                    <span className="trace-frame-fn">{f.fn}</span>
                    <span className="trace-frame-title"> → {f.title}</span>
                    {f.detail && <div className="trace-frame-detail" style={{ paddingLeft: 14 }}>{f.detail}</div>}
                  </div>
                ))}
              </pre>
            )}
          </div>

          <div className="trace-decision" style={{ borderTop: `1px solid ${c.border}` }}>
            <span className="trace-outcome" style={{ color: outColor, background: `${outColor}18`, border: `1px solid ${outColor}3a` }}>
              {String(outcome).replace(/_/g, ' ')}
            </span>
            <span className="trace-decision-text">{dec.rationale}</span>
            {dec.executed_by && <span className="trace-decision-by">by {dec.executed_by}</span>}
          </div>
        </>
      )}
    </div>
  )
}

function TraceSectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="trace-section-label">{children}</div>
}

// ─── TAB: Automated (24h) ─────────────────────────────────────────────────────

function AutomatedTab({ activity, metrics }: { activity: any[]; metrics: any }) {
  const { c } = useTheme()
  const events = activity.filter((e) => (e.kind === 'auto' || e.kind === 'approved') && within24h(e.ts))
  const autoN = events.filter(e => e.kind === 'auto').length
  const apprN = events.filter(e => e.kind === 'approved').length
  return (
    <>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        {[{ l: 'Auto-executed', v: autoN, col: '#8B5CF6', icon: Zap }, { l: 'Human-approved', v: apprN, col: '#10B981', icon: Check }, { l: 'Total (24h)', v: events.length, col: '#0EA5E9', icon: Activity }].map(({ l, v, col, icon: Icon }) => (
          <div key={l} style={{ background: `${col}10`, border: `1px solid ${col}30`, borderRadius: 8, padding: '9px 15px', display: 'flex', gap: 11, alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, background: `${col}20` }}><Icon size={14} color={col} /></span>
            <div><span style={{ fontSize: 20, fontWeight: 900, color: col, lineHeight: 1 }}>{v}</span> <span style={{ fontSize: 11, color: c.textSecondary, fontWeight: 600 }}>{l}</span></div>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Zap size={14} color="#8B5CF6" /><span className="card-title">Actions performed · last 24 hours</span>
        </div>
        {events.length === 0
          ? <div className="card-body" style={{ fontSize: 12, color: c.textMuted, textAlign: 'center', padding: '30px' }}>No automated actions in the last 24 hours.</div>
          : <div>{events.map((e, i) => <AuditRow key={i} ev={e} first={i === 0} />)}</div>}
      </div>
    </>
  )
}

// ─── TAB: Capabilities (what ATLAS runs under the hood) ────────────────────────

function AgentsTab({ agents, onAutonomy, onFilter }: { agents: any[]; onAutonomy: (id: string, l: 'manual' | 'semi' | 'auto') => void; onFilter: (id: string) => void }) {
  const { c } = useTheme()
  const capabilities = agents.filter((a) => a.id !== 'orchestrator')
  return (
    <>
      <div style={{ fontSize: 12, color: c.textMuted, marginBottom: 14, lineHeight: 1.55, maxWidth: 720 }}>
        {MASTER_AGENT.name} is the only agent you ever deal with — everything it proposes, automates or logs
        comes through one identity. This is the coverage running underneath it, area by area.
      </div>
      <div className="auto-grid" style={{ '--col-min': '340px', '--grid-gap': '14px' } as React.CSSProperties}>
        {capabilities.map((a) => <AgentCard key={a.id} agent={a} onAutonomy={(l) => onAutonomy(a.id, l)} onFilter={() => onFilter(a.id)} />)}
      </div>
    </>
  )
}

function AgentCard({ agent, onAutonomy, onFilter }: { agent: any; onAutonomy: (l: 'manual' | 'semi' | 'auto') => void; onFilter: () => void }) {
  const { c } = useTheme()
  const Icon = AGENT_ICONS[agent.icon] ?? Bot
  const st = STATUS_CFG[agent.status] ?? STATUS_CFG.monitoring
  const trust = agent.trust ?? { score: 72, sample: 0, auto_executed: 0 }
  const tc = trust.score >= 80 ? '#10B981' : trust.score >= 60 ? '#F59E0B' : '#EF4444'
  const isOrch = agent.id === 'orchestrator'
  return (
    <div className="card" style={{ borderTop: `3px solid ${agent.accent}`, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '13px 15px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 9, background: `${agent.accent}18`, border: `1px solid ${agent.accent}33`, flexShrink: 0 }}><Icon size={18} color={agent.accent} /></span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: c.textPrimary }}>{agent.name}</div>
            <div style={{ fontSize: 11, color: c.textMuted }}>{agent.role}{agent.module_label && agent.id !== 'custom' ? ` · ${agent.module_label}` : ''}</div>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: st.color, whiteSpace: 'nowrap' }}><CircleDot size={9} /> {st.label}</span>
        </div>
        <div style={{ fontSize: 11.5, color: c.textSecondary, lineHeight: 1.55, marginTop: 10 }}>{agent.mandate}</div>
        {agent.sections?.length > 0 && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 10 }}>
            {agent.sections.map((s: string) => <span key={s} style={{ fontSize: 11, color: c.textSecondary, background: c.surfaceSubtle, border: `1px solid ${c.border}`, borderRadius: 6, padding: '2px 7px' }}>{s}</span>)}
          </div>
        )}
      </div>
      <div style={{ marginTop: 'auto', padding: '10px 15px', borderTop: `1px solid ${c.borderSubtle}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1 }} title={`${trust.approved ?? 0}/${trust.sample ?? 0} human approvals · ${trust.auto_executed ?? 0} auto-executed`}>
          <span style={{ fontSize: 11, fontWeight: 700, color: c.textMuted, textTransform: 'uppercase' }}>Trust</span>
          <div style={{ width: 46, height: 4, borderRadius: 3, background: c.surfaceMuted, overflow: 'hidden' }}><div style={{ width: `${trust.score}%`, height: '100%', background: tc }} /></div>
          <span style={{ fontSize: 11, fontWeight: 800, color: tc }}>{trust.score}</span>
        </div>
        {agent.pending_count > 0 && <button className="btn btn-secondary btn-sm" style={{ padding: '2px 8px' }} onClick={onFilter}>{agent.pending_count} pending</button>}
        {!isOrch && (
          <div className="autonomy-mini" style={{ background: c.surfaceMuted, border: `1px solid ${c.border}` }}>
            {AUTO_MINI.map((l) => (
              <button key={l.key} onClick={() => onAutonomy(l.key)} title={`${l.key} autonomy`} className={`autonomy-mini-btn${agent.autonomy === l.key ? ' on' : ''}`}
                style={agent.autonomy === l.key ? { background: l.key === 'auto' ? '#F59E0B' : '#8B5CF6', color: '#fff' } : { color: c.textMuted }}>{l.label}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── TAB: Audit Log (trace of AI decisions & actions) ─────────────────────────

function AuditTab({ activity, agents }: { activity: any[]; agents: any[] }) {
  const { c } = useTheme()
  const [kind, setKind] = useState('all')
  const [agentId, setAgentId] = useState('all')
  const kinds = [['all', 'All'], ['auto', 'Auto-executed'], ['approved', 'Approved'], ['operator', 'On the module'], ['dismissed', 'Dismissed'], ['governance', 'Governance']]
  const filtered = activity.filter((e) => (kind === 'all' || e.kind === kind) && (agentId === 'all' || e.agent_id === agentId))
  return (
    <>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <ListFilter size={14} color={c.textSecondary} />
        {kinds.map(([k, l]) => <button key={k} className={`btn ${kind === k ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setKind(k)}>{l}</button>)}
        <div style={{ width: 1, height: 20, background: c.border, margin: '0 4px' }} />
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} style={{ fontSize: 12, padding: '5px 9px', borderRadius: 6, border: `1px solid ${c.border}`, background: c.surface, color: c.textPrimary }}>
          <option value="all">All areas</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.module_label ?? a.name}</option>)}
        </select>
      </div>
      <div className="card">
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <ScrollText size={14} color={c.textSecondary} /><span className="card-title">Decision & action trace</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: c.textMuted }}>{filtered.length} entries</span>
        </div>
        {filtered.length === 0
          ? <div className="card-body" style={{ fontSize: 12, color: c.textMuted, textAlign: 'center', padding: '30px' }}>No matching audit entries.</div>
          : <div style={{ maxHeight: '62vh', overflowY: 'auto' }}>{filtered.map((e, i) => <AuditRow key={i} ev={e} first={i === 0} trace />)}</div>}
      </div>
    </>
  )
}

function AuditRow({ ev, first }: { ev: any; first: boolean; trace?: boolean }) {
  const { c } = useTheme()
  const cfg = ACT_KIND[ev.kind] ?? ACT_KIND.proposed
  const Icon = cfg.icon
  const by = ev.by === 'fleet-auto' ? null : ev.by   // "fleet-auto" just means it ran on its own — nothing to attribute
  return (
    <div style={{ display: 'flex', gap: 11, padding: '11px 15px', borderTop: first ? 'none' : `1px solid ${c.borderSubtle}` }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flexShrink: 0 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, background: `${cfg.color}18`, border: `1px solid ${cfg.color}33` }}><Icon size={13} color={cfg.color} /></span>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '1px 6px', borderRadius: 8, color: cfg.color, background: `${cfg.color}18` }}>{cfg.verb}</span>
          <span style={{ fontSize: 12, color: c.textPrimary }}>{ev.title}</span>
        </div>
        {ev.detail && <div style={{ fontSize: 11, color: c.textMuted, marginTop: 3, lineHeight: 1.5 }}>{ev.detail}</div>}
        <div style={{ fontSize: 11, color: c.textMuted, marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
          <Clock size={9} /> {new Date(ev.ts).toLocaleString('en-GB')} · {timeAgo(ev.ts)}
          {ev.module_label ? <> · {ev.module_label}</> : ''}
          {by ? <> · <b style={{ color: c.textSecondary, fontWeight: 700 }}>{by}</b></> : ''}
        </div>
        {/* An entry you cannot reconstruct the reasoning for is not auditable —
            so the trace travels with the action into the log. */}
        {ev.trace && <div style={{ marginTop: 8 }}><TraceView trace={ev.trace} compact /></div>}
      </div>
    </div>
  )
}

// ─── TAB: Governance ──────────────────────────────────────────────────────────

// Governance answers one question for every single thing a person can do in this
// product: can ATLAS do it on its own, and if not, why not? The catalog below is
// the same data structure the engine evaluates before it self-executes anything —
// there is no second copy of the policy, so what is written here is what runs.

// The read-only class is deliberately NOT listed. Reading, filtering, drilling
// and navigating are things ATLAS does continuously and silently; there is no
// decision in them, nothing to approve and nothing to tune. Listing them here
// buried the actions that DO carry a decision under twice as many that never
// will. The engine still holds them — the policy is unchanged — the governance
// surface just stops reporting the part of it that never asks anything of a human.
const CLASS_META: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  auto:    { label: 'Autonomous', color: '#10B981', icon: Zap },
  human:   { label: 'Human decision', color: '#8B5CF6', icon: UserCheck },
  dual:    { label: 'Dual control', color: '#EF4444', icon: ShieldAlert },
}
const CAT_LABEL: Record<string, string> = {
  analyse: 'Analyse & model', execute: 'Execute & change', govern: 'Govern & configure',
}

function GovernanceTab({ fleet, onCreateRule, onDeleteRule, creatingRule }: any) {
  const { c } = useTheme()
  const { data: gov } = useQuery({ queryKey: ['agent-governance'], queryFn: fetchGovernance, staleTime: 300_000 })
  const [moduleFilter, setModuleFilter] = useState('all')
  const [classFilter, setClassFilter] = useState('all')
  const [catFilter, setCatFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [openRow, setOpenRow] = useState<string | null>(null)

  // Only the actions that carry a decision. Read-only ones are dropped here, at
  // the surface, not in the catalog — see CLASS_META above.
  const catalog: any[] = gov?.actions ?? fleet?.action_catalog ?? []
  const actions = useMemo(() => catalog.filter((a) => a.autonomy !== 'observe'), [catalog])
  const guardrails = gov?.guardrails ?? fleet?.guardrails ?? {}

  // Counted off the filtered set so the posture line and the tiles below it can
  // never disagree with the table they are describing.
  const summary = useMemo(() => {
    const by_class: Record<string, number> = {}
    actions.forEach((a) => { by_class[a.autonomy] = (by_class[a.autonomy] ?? 0) + 1 })
    const auto = by_class.auto ?? 0
    return {
      governed: actions.length, by_class, autonomous: auto,
      human_gated: (by_class.human ?? 0) + (by_class.dual ?? 0),
      autonomy_pct: actions.length ? Math.round((auto / actions.length) * 100) : 0,
    }
  }, [actions])

  const modules: { key: string; label: string; count: number }[] = []
  const seen = new Map<string, number>()
  actions.forEach((a) => seen.set(a.module, (seen.get(a.module) ?? 0) + 1))
  seen.forEach((count, key) => modules.push({
    key, count, label: actions.find((a) => a.module === key)?.module_label ?? key,
  }))
  modules.sort((a, b) => b.count - a.count)

  const rows = actions
    .filter((a) => moduleFilter === 'all' || a.module === moduleFilter)
    .filter((a) => classFilter === 'all' || a.autonomy === classFilter)
    .filter((a) => catFilter === 'all' || a.category === catFilter)
    .filter((a) => !query || `${a.label} ${a.module_label} ${a.tab} ${a.section} ${a.description}`.toLowerCase().includes(query.toLowerCase()))

  // Group by module → tab so the table reads like the product's own navigation.
  const grouped: { module: string; module_label: string; tabs: { tab: string; rows: any[] }[] }[] = []
  rows.forEach((a) => {
    let m = grouped.find((g) => g.module === a.module)
    if (!m) { m = { module: a.module, module_label: a.module_label, tabs: [] }; grouped.push(m) }
    let t = m.tabs.find((x) => x.tab === a.tab)
    if (!t) { t = { tab: a.tab, rows: [] }; m.tabs.push(t) }
    t.rows.push(a)
  })

  return (
    <div className="governance">
      {/* Posture — the one-line answer to "how much of this product runs itself?" */}
      <div className="gov-posture">
        <div className="gov-posture-main">
          <div className="gov-posture-title"><ShieldCheck size={15} color="#0EA5E9" /> Autonomy policy</div>
          <div className="gov-posture-text">
            <b>{summary.governed}</b> actions across the control tower carry a decision. ATLAS may perform{' '}
            <b>{summary.autonomous}</b> of them on its own ({summary.autonomy_pct}%) inside the guardrails below.
            The remaining <b>{summary.human_gated}</b> always come to a human — they are irreversible,
            commit unplanned spend, or are judgement the business owns. Reading, filtering and navigating
            are not listed: ATLAS does those continuously and there is nothing to approve.
          </div>
        </div>
        <div className="gov-posture-classes">
          {Object.entries(CLASS_META).map(([k, m]) => (
            <button key={k} className={`gov-class-tile${classFilter === k ? ' active' : ''}`}
              onClick={() => setClassFilter(classFilter === k ? 'all' : k)}
              style={{ borderTop: `2px solid ${m.color}` }} title={gov?.autonomy_classes?.[k]?.blurb}>
              <m.icon size={13} color={m.color} />
              <b style={{ color: m.color }}>{summary.by_class[k] ?? 0}</b>
              <span>{m.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Guardrails — the money limits that sit above every per-action threshold */}
      <div className="card gov-guardrails">
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Gauge size={14} color="#F59E0B" /><span className="card-title">Spend guardrails</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: c.textMuted }}>
            Applied only to actions that commit money — a stock transfer moves what we already own
          </span>
        </div>
        <div className="gov-guardrail-row">
          <GuardrailStat label="Auto-approve under" value={`£${(guardrails.auto_approve_under_gbp ?? 0).toLocaleString()}`}
            hint="Spend below this can self-execute if the action's own gates also pass." />
          <GuardrailStat label="Dual control at or above" value={`£${(guardrails.requires_dual_control_over_gbp ?? 0).toLocaleString()}`}
            hint="Two named approvers required. Never self-executed at any confidence." />
          <GuardrailStat label="Hard spend ceiling" value={`£${(guardrails.spend_ceiling_gbp ?? 0).toLocaleString()}`}
            hint="No single agent-originated commitment may exceed this, approved or not." />
        </div>
      </div>

      {/* Filters */}
      <div className="gov-toolbar">
        <div className="agent-chips">
          <FilterChip active={moduleFilter === 'all'} onClick={() => setModuleFilter('all')} label={`All modules (${actions.length})`} />
          {modules.map((m) => (
            <FilterChip key={m.key} active={moduleFilter === m.key} onClick={() => setModuleFilter(m.key)} label={m.label} count={m.count} />
          ))}
        </div>
        <div className="approval-toolbar-right">
          <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} style={selStyle(c)} aria-label="Filter by action type">
            <option value="all">All action types</option>
            {Object.entries(CAT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search actions…"
            aria-label="Search the action catalog" style={{ ...selStyle(c), minWidth: 190 }} />
        </div>
      </div>

      {/* The catalog */}
      <div className="card approval-table-card">
        <div className="approval-table-scroll">
          <table className="data-table gov-table">
            <thead>
              <tr>
                <th>Action</th>
                <th style={{ width: 128 }}>Type</th>
                <th style={{ width: 128 }}>Permission</th>
                <th style={{ width: 132 }}>ATLAS may</th>
                <th>When it needs your approval</th>
                <th style={{ width: 108 }}>Risk</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((m) => (
                <Fragment key={m.module}>
                  <tr className="gov-group-row">
                    <td colSpan={6}>{m.module_label} <span>· {m.tabs.reduce((s, t) => s + t.rows.length, 0)} actions</span></td>
                  </tr>
                  {m.tabs.map((t) => (
                    <Fragment key={`${m.module}-${t.tab}`}>
                      <tr className="gov-tab-row"><td colSpan={6}>{t.tab}</td></tr>
                      {t.rows.map((a) => {
                        const cm = CLASS_META[a.autonomy] ?? CLASS_META.human
                        const isOpen = openRow === a.key
                        return (
                          <Fragment key={a.key}>
                            <tr className={`gov-row${isOpen ? ' expanded' : ''}`}>
                              <td>
                                <button className="approval-title" onClick={() => setOpenRow(isOpen ? null : a.key)} aria-expanded={isOpen}>
                                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                  <span>
                                    <span className="approval-title-main">{a.label}</span>
                                    <span className="approval-title-sub">{a.section}</span>
                                  </span>
                                </button>
                              </td>
                              <td><span className="gov-cat">{CAT_LABEL[a.category] ?? a.category}</span></td>
                              <td>{a.permission ? <code className="gov-perm">{a.permission}</code> : <span style={{ color: c.textMuted }}>—</span>}</td>
                              <td>
                                <span className="gov-class" style={{ color: cm.color, background: `${cm.color}16`, border: `1px solid ${cm.color}33` }}>
                                  <cm.icon size={10} /> {cm.label}
                                </span>
                              </td>
                              <td className="gov-trigger">{a.approval_trigger}</td>
                              <td>
                                <span className={`gov-rev rev-${a.reversibility}`}>{a.reversibility}</span>
                                <span className="gov-blast">{a.blast_radius}</span>
                              </td>
                            </tr>
                            {isOpen && (
                              <tr className="approval-detail-row">
                                <td colSpan={6}>
                                  <div className="gov-detail">
                                    {a.description && <p className="approval-detail-text">{a.description}</p>}
                                    <div className="approval-detail-grid">
                                      <div>
                                        <DetailHeading>On execution</DetailHeading>
                                        <p className="approval-detail-text">{a.executes}</p>
                                        {a.why_human && (<>
                                          <DetailHeading>Why a human decides</DetailHeading>
                                          <p className="approval-detail-text">{a.why_human}</p>
                                        </>)}
                                      </div>
                                      <div>
                                        <DetailHeading>Gates evaluated before it may self-execute</DetailHeading>
                                        <div className="approval-detail-meta">
                                          <MetaPill label="Severity ≤" value={a.severity_ceiling} />
                                          <MetaPill label="Confidence ≥" value={`${a.confidence_floor}%`} />
                                          <MetaPill label="Value ≤" value={a.value_ceiling_gbp ? `£${a.value_ceiling_gbp.toLocaleString()}` : 'n/a'} />
                                          <MetaPill label="Commits spend" value={a.commits_spend ? 'Yes' : 'No'} />
                                          {a.sla_minutes ? <MetaPill label="Target" value={a.sla_minutes >= 60 ? `${Math.round(a.sla_minutes / 60)}h` : `${a.sla_minutes}m`} /> : null}
                                        </div>
                                        {a.consults?.length > 0 && (<>
                                          <DetailHeading>Capabilities consulted before acting</DetailHeading>
                                          <div className="approval-detail-chips">
                                            {a.consults.map((cid: string) => <span key={cid} className="meta-pill" style={{ background: c.surfaceSubtle, border: `1px solid ${c.border}` }}>{cid.replace(/_/g, ' ')}</span>)}
                                          </div>
                                        </>)}
                                      </div>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="approval-table-foot">
          {rows.length} of {actions.length} actions · this table is the policy the engine evaluates, not a description of it
        </div>
      </div>

      <div style={{ maxWidth: 820 }}>
        <WatchRuleStudio rules={fleet?.custom_rules ?? []} metrics={fleet?.custom_metrics ?? []} onCreate={onCreateRule} onDelete={onDeleteRule} creating={creatingRule} />
      </div>
    </div>
  )
}

function GuardrailStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  const { c } = useTheme()
  return (
    <div className="gov-guardrail" style={{ background: c.surfaceSubtle, border: `1px solid ${c.border}` }}>
      <div className="gov-guardrail-label">{label}</div>
      <div className="gov-guardrail-value">{value}</div>
      <div className="gov-guardrail-hint">{hint}</div>
    </div>
  )
}

// ═══ Shared components (reused across tabs) ═══════════════════════════════════

function AutonomyPill({ level, compact }: { level: string; compact?: boolean }) {
  const map: Record<string, string> = { manual: '#64748B', semi: '#8B5CF6', auto: '#F59E0B' }
  const label = level === 'semi' ? 'Semi-Autonomous' : level.charAt(0).toUpperCase() + level.slice(1)
  if (compact) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: map[level] ?? '#8B5CF6' }}>
        <Gauge size={10} /> {label}
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, padding: '5px 11px', borderRadius: 20, color: map[level] ?? '#8B5CF6', background: `${map[level] ?? '#8B5CF6'}18`, border: `1px solid ${map[level] ?? '#8B5CF6'}40` }}>
      <Gauge size={13} /> Autonomy · {label}
    </span>
  )
}

function MetricTile({ icon: Icon, label, value, accent }: { icon: React.ElementType; label: string; value: any; accent: string }) {
  const { c } = useTheme()
  return (
    <div className="agent-metric-tile" style={{ background: c.surface, border: `1px solid ${c.border}`, borderTop: `2px solid ${accent}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, background: `${accent}18`, border: `1px solid ${accent}33`, flexShrink: 0 }}><Icon size={15} color={accent} /></div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: c.textPrimary, lineHeight: 1, letterSpacing: '-0.02em' }}>{value}</div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: c.textMuted, marginTop: 4 }}>{label}</div>
      </div>
    </div>
  )
}

function FilterChip({ active, onClick, label, icon: Icon, accent, count }: { active: boolean; onClick: () => void; label: string; icon?: React.ElementType; accent?: string; count?: number }) {
  const { c } = useTheme()
  return (
    <button onClick={onClick} className="agent-chip" style={{ background: active ? (accent ? `${accent}1a` : c.info.bg) : c.surface, border: `1px solid ${active ? (accent ?? c.info.border) : c.border}`, color: active ? (accent ?? c.info.text) : c.textSecondary }}>
      {Icon && <Icon size={12} color={active ? accent : c.textMuted} />}{label}
      {count != null && count > 0 && <span style={{ fontSize: 11, fontWeight: 800, padding: '0 5px', borderRadius: 9, background: active ? (accent ?? '#3B82F6') : c.surfaceMuted, color: active ? '#fff' : c.textMuted }}>{count}</span>}
    </button>
  )
}

// Why this row is in front of a human at all. Three genuinely different answers,
// and the operator triages differently on each: an action class that is always
// human, a second-approver requirement, or a routine action that simply exceeded
// one of its gates this time. The tooltip carries the specific trigger.
function PolicyChip({ rec }: { rec: any }) {
  const cls = rec.policy_autonomy
  const auto = rec.would_auto
  const kind = cls === 'dual' ? 'dual' : cls === 'human' ? 'human' : auto ? 'auto' : 'threshold'
  const meta = {
    dual:      { label: 'Dual control', color: '#EF4444', Icon: ShieldAlert },
    human:     { label: 'Human decision', color: '#8B5CF6', Icon: ShieldCheck },
    auto:      { label: 'Auto-class', color: '#10B981', Icon: Zap },
    threshold: { label: 'Above threshold', color: '#F59E0B', Icon: ShieldAlert },
  }[kind]!
  const why = rec.governance?.why_human || rec.governance?.approval_trigger
  const fallback = {
    dual: 'Requires two named approvers',
    human: 'This action always requires human approval',
    auto: 'This action self-executes within guardrails',
    threshold: `Exceeded a gate this time${rec.trace?.policy?.blocking_gate ? ` — ${rec.trace.policy.blocking_gate}` : ''}`,
  }[kind]
  return (
    <span title={why || fallback}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 20, color: meta.color, background: `${meta.color}16`, border: `1px solid ${meta.color}33` }}>
      <meta.Icon size={9} /> {meta.label}
    </span>
  )
}

function ConfidenceMeter({ value, color }: { value: number; color: string }) {
  const { c } = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={`${value}% confidence`}>
      <div style={{ width: 52, height: 5, borderRadius: 3, background: c.surfaceMuted, overflow: 'hidden' }}><div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: 3 }} /></div>
      <span style={{ fontSize: 11, fontWeight: 800, color: c.textSecondary }}>{value}%</span>
    </div>
  )
}

function ImpactPill({ imp }: { imp: any }) {
  const { c } = useTheme()
  const dir = imp.direction
  const color = dir === 'up' ? '#10B981' : dir === 'down' ? '#0EA5E9' : c.textMuted
  const Icon = dir === 'up' ? TrendingUp : dir === 'down' ? TrendingDown : Minus
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3px 9px', borderRadius: 7, background: `${color}14`, border: `1px solid ${color}2e`, color: c.textPrimary }}>
      <Icon size={12} color={color} /><span style={{ color: c.textMuted }}>{imp.label}</span><b style={{ color }}>{imp.value}</b>
    </span>
  )
}

const STATUS_CFG: Record<string, { label: string; color: string }> = {
  attention: { label: 'Needs approval', color: '#F97316' },
  advising: { label: 'Advising', color: '#3B82F6' },
  monitoring: { label: 'Monitoring', color: '#10B981' },
}

// ─── watch-rule studio ──────────────────────────────────────────────────────

function WatchRuleStudio({ rules, metrics, onCreate, onDelete, creating }: { rules: any[]; metrics: any[]; onCreate: (r: any) => void; onDelete: (id: string) => void; creating: boolean }) {
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  const [metric, setMetric] = useState('')
  const [operator, setOperator] = useState('<')
  const [threshold, setThreshold] = useState('')
  const [severity, setSeverity] = useState('medium')
  const metricMeta = metrics.find((m) => m.key === metric)
  const create = () => {
    if (!metric || threshold === '') return
    onCreate({ metric, operator, threshold: Number(threshold), severity })
    setMetric(''); setThreshold(''); setOperator('<'); setSeverity('medium'); setOpen(false)
  }
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Wand2 size={14} color="#EC4899" /><span className="card-title">Watch Rules · No-Code Studio</span>
        <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto', padding: '2px 8px' }} onClick={() => setOpen(o => !o)}>{open ? <X size={12} /> : <Plus size={12} />} {open ? 'Close' : 'New'}</button>
      </div>
      {open && (
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${c.borderSubtle}`, background: c.surfaceSubtle, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <select value={metric} onChange={(e) => setMetric(e.target.value)} style={selStyle(c)}>
            <option value="">Choose a metric to watch…</option>
            {metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 6 }}>
            <select value={operator} onChange={(e) => setOperator(e.target.value)} style={{ ...selStyle(c), width: 64 }}>{['<', '<=', '>', '>=', '=='].map((o) => <option key={o} value={o}>{o}</option>)}</select>
            <input value={threshold} onChange={(e) => setThreshold(e.target.value.replace(/[^0-9.]/g, ''))} placeholder={`threshold${metricMeta?.unit ? ` (${metricMeta.unit})` : ''}`} inputMode="decimal" style={{ ...selStyle(c), flex: 1 }} />
            <select value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ ...selStyle(c), width: 118 }}>{['critical', 'high', 'medium', 'low', 'opportunity'].map((s) => <option key={s} value={s}>{SEVERITY[s].label}</option>)}</select>
          </div>
          <button className="btn btn-primary btn-sm" disabled={creating || !metric || threshold === ''} onClick={create} style={{ justifyContent: 'center' }}><Plus size={13} /> Create watch rule</button>
        </div>
      )}
      {rules.length === 0
        ? <div className="card-body" style={{ fontSize: 11.5, color: c.textMuted, textAlign: 'center', padding: '18px 14px' }}>No custom rules yet. Author one — no code — to watch your own thresholds.</div>
        : <div>{rules.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: `1px solid ${c.borderSubtle}` }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, background: `${SEVERITY[r.severity]?.color}18`, border: `1px solid ${SEVERITY[r.severity]?.color}33`, flexShrink: 0 }}><Gauge size={13} color={SEVERITY[r.severity]?.color} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
                <div style={{ fontSize: 11, color: c.textMuted }}>now {r.current_value ?? '—'} · fires {r.operator} {r.threshold}</div>
              </div>
              {r.firing ? <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--status-danger-text)', background: '#EF444418', border: '1px solid #EF444433', borderRadius: 8, padding: '1px 6px' }}>FIRING</span> : <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--status-success-text)', background: '#10B98118', border: '1px solid #10B98133', borderRadius: 8, padding: '1px 6px' }}>OK</span>}
              <button onClick={() => onDelete(r.id)} title="Delete rule" style={{ background: 'none', border: 'none', cursor: 'pointer', color: c.textMuted, padding: 3 }}><Trash2 size={13} /></button>
            </div>
          ))}</div>}
    </div>
  )
}
function selStyle(c: any): React.CSSProperties {
  return { fontSize: 12, padding: '7px 9px', borderRadius: 6, border: `1px solid ${c.border}`, background: c.surface, color: c.textPrimary }
}

