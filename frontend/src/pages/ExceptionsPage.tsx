import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '../components/ui/PageHeader'
import { ActionedToday } from '../components/ui/ResolutionPanel'
import { fetchExceptions, fetchRiskPlans, acknowledgeException, resolveException, activateRiskPlan } from '../lib/api'
import { useStore } from '../store/useStore'
import { useWebSocket } from '../hooks/useWebSocket'
import { useTheme } from '../hooks/useTheme'
import { usePermissions } from '../hooks/usePermissions'
import { AlertTriangle, CheckCircle, Clock, X, Sparkles, AlertOctagon, FolderOpen, Check, Target, Zap } from 'lucide-react'

// ─── constants ────────────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 }
const PRIORITY_COLOR: Record<string, string> = {
  P1: '#EF4444', P2: '#F97316', P3: '#F59E0B', P4: '#6B7280',
}
const SLA_MINUTES: Record<string, number> = { P1: 5, P2: 30, P3: 240, P4: 1440 }
const RISK_LEVEL_COLOR: Record<string, string> = {
  Critical: '#EF4444', High: '#F97316', Medium: '#F59E0B', Low: '#10B981',
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function elapsedMinutes(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
}

function fmtElapsed(mins: number) {
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

// ─── main page ───────────────────────────────────────────────────────────────

export function ExceptionsPage({ embedded = false }: { embedded?: boolean }) {
  const { c } = useTheme()
  const [priorityFilter, setPriorityFilter] = useState<'all' | 'P1' | 'P2' | 'P3' | 'P4'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'acknowledged' | 'resolved'>('all')
  const [selected, setSelected] = useState<any | null>(null)
  const user = useStore(s => s.user)
  const queryClient = useQueryClient()

  const { data: exceptions, refetch } = useQuery({
    queryKey: ['exceptions-page'],
    queryFn: () => fetchExceptions(),
    refetchInterval: 15_000,
    refetchOnMount: 'always',
  })

  // Scenario/risk-plan registry — keyed by scenario_id, looked up per exception
  // to render its AI Risk Plan (Immediate playbook + Short/Long term actions).
  const { data: riskPlans } = useQuery({
    queryKey: ['risk-plans'],
    queryFn: fetchRiskPlans,
    staleTime: Infinity,
  })

  useWebSocket('exceptions', useCallback((type: string) => {
    if (['p1_active', 'status_change', 'scenario_applied', 'exceptions_tick'].includes(type)) refetch()
  }, [refetch]))

  // Keep selected in sync with live data
  const selectedCode = selected?.exception_code
  useEffect(() => {
    if (!selectedCode || !exceptions?.items) return
    const fresh = exceptions.items.find((e: any) => e.exception_code === selectedCode)
    if (fresh) setSelected(fresh)
  }, [exceptions, selectedCode])

  const acknowledgeMutation = useMutation({
    mutationFn: ({ code, notes }: { code: string; notes?: string }) =>
      acknowledgeException(code, user?.email || 'unknown', notes),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['exceptions-page'] })
      if (updated?.exception_code) setSelected(updated)
    },
  })

  const resolveMutation = useMutation({
    mutationFn: ({ code, rootCause, notes }: { code: string; rootCause: string; notes?: string }) =>
      resolveException(code, user?.email || 'unknown', rootCause, notes),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['exceptions-page'] })
      if (updated?.exception_code) setSelected(updated)
    },
  })

  const activatePlanMutation = useMutation({
    mutationFn: (code: string) => activateRiskPlan(code, user?.email || 'unknown'),
    onSuccess: (updated) => {
      // Activating a plan triggers real compensatory effects across KPIs,
      // warehouse, inventory, fleet and supplier data (see
      // SyntheticState._apply_plan_compensation) — not just this exception —
      // so every page's cached data needs refetching, not only this query.
      queryClient.invalidateQueries({ refetchType: 'all' })
      if (updated?.exception_code) setSelected(updated)
    },
  })

  const allItems: any[] = (exceptions?.items || []).sort(
    (a: any, b: any) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
  )

  const filtered = allItems.filter((e) => {
    if (priorityFilter !== 'all' && e.priority !== priorityFilter) return false
    if (statusFilter !== 'all' && e.status !== statusFilter) return false
    return true
  })

  const counts = { P1: 0, P2: 0, P3: 0, P4: 0 } as Record<string, number>
  allItems.forEach((e) => { counts[e.priority] = (counts[e.priority] || 0) + 1 })
  const openCount = allItems.filter((e) => e.status === 'open').length
  const withPlanCount = allItems.filter((e) => e.scenario_id && riskPlans?.[e.scenario_id]?.risk_plan).length

  const selectedPlan = selected?.scenario_id ? riskPlans?.[selected.scenario_id]?.risk_plan : null

  return (
    <>
      {!embedded && <PageHeader title="Exception Management" subtitle="Real-time alerts · AI risk plans · Resolution tracking" />}
      <div className={embedded ? '' : 'page-body'}>

        {/* Summary strip */}
        <div data-tour="exc-summary" style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { icon: AlertOctagon, label: 'Open P1', value: allItems.filter(e => e.priority === 'P1' && e.status === 'open').length, color: '#EF4444', bg: c.danger.bg, border: c.danger.border },
            { icon: AlertTriangle, label: 'Open P2', value: allItems.filter(e => e.priority === 'P2' && e.status === 'open').length, color: '#F97316', bg: c.warning.bg, border: c.warning.border },
            { icon: FolderOpen, label: 'Total Open', value: openCount, color: c.textSecondary, bg: c.surfaceSubtle, border: c.border },
            { icon: Sparkles, label: 'With AI Risk Plan', value: withPlanCount, color: '#8B5CF6', bg: c.info.bg, border: c.info.border },
          ].map(({ icon: Icon, label, value, color, bg, border }) => (
            <div key={label} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 8, padding: '8px 14px', display: 'flex', gap: 12, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 6, background: color === c.textSecondary ? 'var(--clt-grey-200)' : `${color}20` }}>
                <Icon size={14} strokeWidth={2.5} color={color === c.textSecondary ? 'var(--clt-grey-600)' : color} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 20, fontWeight: 900, color, lineHeight: 1 }}>{value}</span>
                <span style={{ fontSize: 11, color: c.textSecondary, fontWeight: 600 }}>{label}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Filter row */}
        <div data-tour="exc-filters" style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--clt-grey-400)', marginRight: 2 }}>PRIORITY</span>
          {(['all', 'P1', 'P2', 'P3', 'P4'] as const).map((p) => (
            <button key={p} className={`btn ${priorityFilter === p ? 'btn-primary' : 'btn-secondary'} btn-sm`}
              onClick={() => setPriorityFilter(p)}>
              {p === 'all' ? 'All' : p}
              {p !== 'all' && counts[p] > 0 && (
                <span style={{ background: 'rgba(255,255,255,0.25)', borderRadius: 10, padding: '0 5px', marginLeft: 4 }}>{counts[p]}</span>
              )}
            </button>
          ))}
          <div style={{ width: 1, height: 20, background: 'var(--clt-grey-200)', margin: '0 4px' }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--clt-grey-400)', marginRight: 2 }}>STATUS</span>
          {(['all', 'open', 'acknowledged', 'resolved'] as const).map((s) => (
            <button key={s} className={`btn ${statusFilter === s ? 'btn-primary' : 'btn-secondary'} btn-sm`}
              onClick={() => setStatusFilter(s)} style={{ textTransform: 'capitalize' }}>
              {s === 'all' ? 'All Statuses' : s}
            </button>
          ))}
        </div>

        <div className="grid-2-1" style={{ alignItems: 'flex-start' }}>

          {/* Exception list */}
          <div data-tour="exc-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filtered.length === 0 ? (
              <div className="card">
                <div className="empty-state">
                  <div style={{ color: 'var(--status-success-text)', marginBottom: 8 }}><CheckCircle size={40} /></div>
                  <div style={{ fontWeight: 600 }}>No exceptions match current filters</div>
                </div>
              </div>
            ) : (
              <div className="card" style={{ overflow: 'hidden' }}>
                <div style={{ padding: '10px 16px', background: 'var(--clt-grey-50)', borderBottom: '1px solid var(--clt-grey-200)', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--clt-grey-500)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={11} /> Operational Alerts ({filtered.length})
                </div>
                {/* Auto-acknowledgement is triage, not a decision — so it leaves
                    no mark on the queue beyond an owner and a running clock. */}
                <div style={{ padding: '10px 16px 0' }}>
                  <ActionedToday module="/exceptions" section="Exception Queue" label="exception"
                    emptyHint="No exceptions acknowledged or escalated yet today." />
                </div>
                {filtered.map((exc: any) => (
                  <ExcRow key={exc.exception_code} exc={exc} selected={selected} onSelect={setSelected}
                    hasPlan={!!(exc.scenario_id && riskPlans?.[exc.scenario_id]?.risk_plan)} />
                ))}
              </div>
            )}
          </div>

          {/* Detail panel */}
          {selected ? (
            <ExceptionDetail
              exc={selected}
              riskPlan={selectedPlan}
              onClose={() => setSelected(null)}
              onAcknowledge={(notes) => acknowledgeMutation.mutate({ code: selected.exception_code, notes })}
              onResolve={(rootCause, notes) => resolveMutation.mutate({ code: selected.exception_code, rootCause, notes })}
              onActivatePlan={() => activatePlanMutation.mutate(selected.exception_code)}
              acknowledging={acknowledgeMutation.isPending}
              resolving={resolveMutation.isPending}
              activatingPlan={activatePlanMutation.isPending}
              userEmail={user?.email || 'unknown'}
            />
          ) : (
            <div className="card">
              <div className="card-body empty-state">
                <div style={{ fontSize: 32 }}>👆</div>
                <div>Select an exception to view details</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ─── AI Risk Plan panel (shared) ──────────────────────────────────────────────

function RiskPlanPanel({ plan, exc, onActivate, activating, canActivate }: {
  plan: any
  exc: any
  onActivate: () => void
  activating: boolean
  canActivate: boolean
}) {
  const { c } = useTheme()
  const rlColor = RISK_LEVEL_COLOR[plan.risk_level] ?? '#94A3B8'

  return (
    <div style={{ border: `1px solid #C4B5FD`, borderRadius: 8, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ background: 'var(--status-ai-bg)', padding: '10px 12px', borderBottom: '1px solid var(--status-ai-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <Sparkles size={12} color="#6D28D9" />
          <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--status-ai-text)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>AI Risk Plan</span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#4C1D95' }}>{plan.playbook_name}</div>
        {plan.trigger && (
          <div style={{ fontSize: 11, color: 'var(--status-ai-text)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Target size={10} /> Trigger: {plan.trigger}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {[
            { k: 'Risk', v: plan.risk_level, col: rlColor },
            { k: 'Likelihood', v: plan.likelihood, col: '#3B82F6' },
            { k: 'Impact', v: plan.impact, col: '#8B5CF6' },
          ].map(({ k, v, col }) => (
            <div key={k} style={{ fontSize: 11, background: 'var(--bg-card)', border: '1px solid var(--status-ai-border)', borderRadius: 6, padding: '3px 8px' }}>
              <span style={{ color: 'var(--text-tertiary)' }}>{k}: </span>
              <b style={{ color: col }}>{v}</b>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: '11px 12px', background: c.surface }}>
        <div style={{ fontSize: 11.5, color: c.textSecondary, lineHeight: 1.6, marginBottom: 12 }}>
          {plan.summary}
        </div>

        {/* Immediate — the playbook itself, numbered */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--status-danger-text)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Immediate — Response Playbook · act now
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {plan.immediate.map((step: any, i: number) => (
              <PlanAction key={i} step={step} n={i + 1} tone="#EF4444" />
            ))}
          </div>

          {/* User control: activate the Immediate response plan */}
          {exc.plan_activated ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 10, fontSize: 11, color: 'var(--status-danger-text)', fontWeight: 600 }}>
              <Check size={12} /> Activated by {exc.plan_activated_by} · {new Date(exc.plan_activated_at).toLocaleString('en-GB')}
            </div>
          ) : exc.status !== 'resolved' && canActivate ? (
            <button
              onClick={onActivate}
              disabled={activating}
              style={{
                marginTop: 10, width: '100%', padding: '8px 0', borderRadius: 7, border: 'none', cursor: 'pointer',
                background: '#EF4444', color: '#fff', fontSize: 12, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                opacity: activating ? 0.7 : 1,
              }}
            >
              {activating ? 'Activating…' : <><Zap size={13} /> Activate Response Plan</>}
            </button>
          ) : null}
        </div>

        {/* Short term */}
        {plan.short_term?.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--status-warning-text)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Short Term · days to weeks — stabilise & recover
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {plan.short_term.map((step: any, i: number) => (
                <PlanAction key={i} step={step} tone="#F59E0B" />
              ))}
            </div>
          </div>
        )}

        {/* Long term */}
        {plan.long_term?.length > 0 && (
          <div style={{ marginBottom: plan.kpis_to_watch?.length ? 10 : 0 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--status-success-text)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Long Term · quarters — remove the structural cause
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {plan.long_term.map((step: any, i: number) => (
                <PlanAction key={i} step={step} tone="#10B981" />
              ))}
            </div>
          </div>
        )}

        {plan.kpis_to_watch?.length > 0 && (
          <div style={{ fontSize: 11, color: c.textMuted, borderTop: `1px solid ${c.border}`, paddingTop: 8 }}>
            <b>KPIs to watch:</b> {plan.kpis_to_watch.join(' · ')}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Exception detail panel ───────────────────────────────────────────────────

// An action is only actionable if it says who owns it, by when, and what it is
// worth. Objects carry that; plain strings still render for any legacy plan.
function PlanAction({ step, n, tone }: { step: any; n?: number; tone: string }) {
  const { c } = useTheme()
  const isObj = step && typeof step === 'object'
  const text = isObj ? step.action : step
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      {n != null ? (
        <div style={{ width: 17, height: 17, borderRadius: '50%', background: tone, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
          <span style={{ fontSize: 11, fontWeight: 900, color: '#fff' }}>{n}</span>
        </div>
      ) : (
        <span style={{ color: tone, flexShrink: 0, lineHeight: 1.5, fontSize: 11.5 }}>•</span>
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: n != null ? 12 : 11.5, color: n != null ? c.textPrimary : c.textSecondary, lineHeight: 1.45 }}>{text}</div>
        {isObj && (step.owner || step.by || step.impact) && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 3, alignItems: 'center' }}>
            {step.owner && <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 10, background: c.chipBg, color: c.chipText }}>{step.owner}</span>}
            {step.by && <span style={{ fontSize: 11, fontWeight: 800, padding: '1px 6px', borderRadius: 10, background: `${tone}18`, color: tone }}>{step.by}</span>}
            {step.impact && <span style={{ fontSize: 11, color: c.textMuted, fontStyle: 'italic' }}>{step.impact}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function ExceptionDetail({
  exc, riskPlan, onClose, onAcknowledge, onResolve, onActivatePlan,
  acknowledging, resolving, activatingPlan, userEmail,
}: {
  exc: any
  riskPlan: any
  onClose: () => void
  onAcknowledge: (notes?: string) => void
  onResolve: (rootCause: string, notes?: string) => void
  onActivatePlan: () => void
  acknowledging: boolean
  resolving: boolean
  activatingPlan: boolean
  userEmail: string
}) {
  const navigate = useNavigate()
  const { c } = useTheme()
  const [ackNotes, setAckNotes] = useState('')
  const [showAckForm, setShowAckForm] = useState(false)
  const [showResolveModal, setShowResolveModal] = useState(false)
  const [rootCause, setRootCause] = useState('')
  const [resolveNotes, setResolveNotes] = useState('')

  const { can } = usePermissions()

  // Reset modal states when exception changes
  useEffect(() => {
    setShowAckForm(false)
    setShowResolveModal(false)
    setAckNotes('')
  }, [exc.exception_code])

  const pc = PRIORITY_COLOR[exc.priority] || '#6B7280'
  const slaTarget = SLA_MINUTES[exc.priority] || 60
  const elapsedMins = exc.created_at ? elapsedMinutes(exc.created_at) : 0
  const slaBreached = exc.status === 'open' && elapsedMins > slaTarget
  const slaWarn = exc.status === 'open' && elapsedMins > slaTarget * 0.7 && !slaBreached

  // Workflow steps
  const steps = [
    { key: 'raised', label: 'Raised', done: true, active: exc.status === 'open' },
    { key: 'acknowledged', label: 'Acknowledged', done: exc.status !== 'open', active: exc.status === 'acknowledged' },
    { key: 'resolved', label: 'Resolved', done: exc.status === 'resolved', active: exc.status === 'resolved' },
  ]

  const headerBg = exc.status === 'resolved' ? c.success.bg
    : exc.status === 'open' ? (slaBreached ? c.danger.bg : c.warning.bg)
    : c.surfaceSubtle

  return (
    <div className="card" data-tour="exc-detail" style={{
      position: 'sticky', top: 16, maxHeight: 'calc(100vh - 32px)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>

      {/* Header */}
      <div style={{ background: headerBg, borderBottom: '1px solid var(--clt-grey-200)', padding: '14px 16px', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <span className={`badge badge-${exc.priority.toLowerCase()}`}>{exc.priority}</span>
            <StatusBadge exc={exc} />
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--clt-grey-400)', padding: 2 }}>
            <X size={14} />
          </button>
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--clt-grey-900)', lineHeight: 1.4, marginBottom: 6 }}>{exc.title}</div>
        <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Clock size={10} />
          Raised {new Date(exc.created_at).toLocaleString('en-GB')}
          {exc.status === 'open' && (
            <span style={{ marginLeft: 6, fontWeight: 700, color: slaBreached ? '#EF4444' : slaWarn ? '#F59E0B' : 'var(--clt-grey-500)' }}>
              · {fmtElapsed(elapsedMins)} elapsed
              {slaBreached && ` · SLA BREACHED (>${slaTarget}m)`}
              {slaWarn && ` · SLA warning`}
            </span>
          )}
        </div>
      </div>

      {/* Workflow progress bar */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--clt-grey-100)', background: c.surfaceSubtle, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {steps.map((step, i) => (
            <div key={step.key} style={{ display: 'flex', alignItems: 'center', flex: i < steps.length - 1 ? 1 : 'none' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div style={{
                  width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: step.done ? (step.key === 'resolved' ? '#10B981' : pc) : 'var(--clt-grey-200)',
                  border: step.active && !step.done ? `2px solid ${pc}` : 'none',
                  flexShrink: 0,
                }}>
                  {step.done ? <CheckCircle size={12} color="#fff" /> : <span style={{ fontSize: 11, fontWeight: 800, color: step.active ? pc : 'var(--clt-grey-400)' }}>{i + 1}</span>}
                </div>
                <span style={{ fontSize: 11, fontWeight: step.done || step.active ? 700 : 400, color: step.done ? 'var(--clt-grey-700)' : step.active ? pc : 'var(--clt-grey-400)', whiteSpace: 'nowrap', maxWidth: 68, textAlign: 'center', lineHeight: 1.2 }}>
                  {step.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div style={{ flex: 1, height: 2, background: step.done ? pc : 'var(--clt-grey-200)', margin: '0 4px', marginBottom: 16 }} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/*
        Scroll container: `flex: 1, minHeight: 0` (NOT a fixed maxHeight) is
        what makes this fill the remaining space in the outer flex column and
        scroll correctly. Children are plain block elements with marginBottom
        for spacing (not flexbox) — a flex child with its own `overflow` set
        gets its cross-axis min-size forced to 0, which lets the flexbox
        algorithm shrink it below its content height instead of the container
        scrolling, silently truncating content (this bit us with the AI Risk
        Plan panel, which needs `overflow: hidden` for its rounded corners).
      */}
      <div className="card-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>

        {/* Description */}
        <div style={{ marginBottom: 14 }}>
          <Label>Description</Label>
          <div style={{ fontSize: 12.5, lineHeight: 1.65, color: 'var(--clt-grey-700)' }}>{exc.description}</div>
        </div>

        {/* Acknowledgement info */}
        {exc.acknowledged_by && (
          <div style={{ background: c.warning.bg, border: `1px solid ${c.warning.border}`, borderRadius: 7, padding: '9px 12px', fontSize: 11, marginBottom: 14 }}>
            <div style={{ fontWeight: 700, color: c.warning.text, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 4 }}><Check size={14} /> Acknowledged</div>
            <div style={{ color: c.warning.text }}>By <b>{exc.acknowledged_by}</b> at {new Date(exc.acknowledged_at).toLocaleString('en-GB')}</div>
          </div>
        )}

        {/* Resolution info */}
        {exc.status === 'resolved' && (
          <div style={{ background: c.success.bg, border: `1px solid ${c.success.border}`, borderRadius: 7, padding: '9px 12px', fontSize: 11, marginBottom: 14 }}>
            <div style={{ fontWeight: 700, color: c.success.text, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle size={14} /> Resolved</div>
            <div style={{ color: c.success.text, marginBottom: 2 }}>By <b>{exc.resolved_by}</b> at {new Date(exc.resolved_at).toLocaleString('en-GB')}</div>
            {exc.root_cause && <div style={{ marginTop: 4, color: c.success.text }}><b>Root cause:</b> {exc.root_cause}</div>}
          </div>
        )}

        {/* ═══ AI RISK PLAN (or plain recommended action fallback) ═══════════════ */}
        {riskPlan ? (
          <div style={{ marginBottom: 14 }}>
            <RiskPlanPanel
              plan={riskPlan} exc={exc} onActivate={onActivatePlan}
              activating={activatingPlan} canActivate={can('write:exception')}
            />
          </div>
        ) : exc.recommended_action ? (
          <div style={{ marginBottom: 14 }}>
            <Label>Recommended Action</Label>
            <div style={{ fontSize: 12, background: c.warning.bg, padding: '9px 11px', borderRadius: 6, color: c.warning.text, lineHeight: 1.6, border: `1px solid ${c.warning.border}` }}>
              {exc.recommended_action}
            </div>
          </div>
        ) : null}

        {/* Stats */}
        <div className="auto-grid" style={{ '--col-min': '132px', '--grid-gap': '8px', marginBottom: 14 } as React.CSSProperties}>
          <Stat label="Engineers at Risk" value={exc.impacted_engineer_count} />
          <Stat label="Est. Resolution" value={`${exc.estimated_resolution_hours}h`} />
          <Stat label="Recurrences" value={exc.recurrence_count} alert={exc.recurrence_count > 2} />
        </div>

        {/* Impacted SKUs */}
        {exc.impacted_skus?.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <Label>Impacted SKUs</Label>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {exc.impacted_skus.map((sku: string) => (
                <button
                  key={sku}
                  onClick={() => navigate(`/demand?sku=${encodeURIComponent(sku)}`)}
                  title="Open this SKU in Demand & Inventory"
                  style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', padding: '3px 8px', borderRadius: 4, background: 'var(--clt-grey-100)', color: 'var(--clt-grey-700)', border: '1px dashed var(--clt-grey-400, #94A3B8)', cursor: 'pointer' }}
                >
                  {sku} ↗
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Automated action taken */}
        {exc.automated_action_taken && (
          <div style={{ background: c.success.bg, borderRadius: 6, padding: '9px 11px', fontSize: 12, color: c.success.text, border: `1px solid ${c.success.border}`, marginBottom: 14 }}>
            <b>Automated action:</b> {exc.automated_action_taken}
          </div>
        )}

        {/* Inline acknowledge form */}
        {exc.status === 'open' && showAckForm && (
          <div style={{ background: c.warning.bg, border: `1px solid ${c.warning.border}`, borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: c.warning.text, marginBottom: 8 }}>Acknowledge Exception</div>
            <textarea
              value={ackNotes}
              onChange={(e) => setAckNotes(e.target.value)}
              placeholder="Optional notes (actions being taken, initial assessment…)"
              rows={2}
              style={{ width: '100%', fontSize: 12, padding: '7px 9px', borderRadius: 6, border: `1px solid ${c.warning.border}`, resize: 'none', fontFamily: 'inherit', boxSizing: 'border-box', background: c.surface, color: c.textPrimary }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-sm" style={{ background: '#D97706', color: '#fff', border: 'none' }}
                onClick={() => { onAcknowledge(ackNotes || undefined); setShowAckForm(false) }}
                disabled={acknowledging}>
                {acknowledging ? 'Acknowledging…' : <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Check size={12} /> Confirm Acknowledge</span>}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowAckForm(false)}>Cancel</button>
            </div>
          </div>
        )}

      </div>

      {/* Action bar */}
      {exc.status !== 'resolved' && (
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--clt-grey-100)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
          {/* Plain Acknowledge is only needed when there's no AI plan to activate — the
              "Activate Response Plan" button above already acknowledges when a plan exists. */}
          {exc.status === 'open' && !showAckForm && !riskPlan && can('write:exception') && (
            <button className="btn btn-secondary btn-sm" onClick={() => setShowAckForm(true)}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Check size={12} /> Acknowledge</span>
            </button>
          )}
          {exc.status === 'acknowledged' && can('write:exception') && (
            <button className="btn btn-sm" style={{ background: '#059669', color: '#fff', border: 'none', fontSize: 12 }}
              onClick={() => setShowResolveModal(true)}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle size={12} /> Mark as Resolved</span>
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={onClose} style={{ marginLeft: 'auto' }}>Close</button>
        </div>
      )}

      {/* ═══ RESOLVE MODAL ══════════════════════════════════════════════════════ */}
      {showResolveModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: c.surface, borderRadius: 12, padding: 28, maxWidth: 460, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--status-success-text)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Mark as Resolved
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--clt-grey-900)', marginBottom: 14 }}>
              {exc.title}
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--clt-grey-500)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 5 }}>
                Root Cause <span style={{ color: 'var(--status-danger-text)' }}>*</span>
              </label>
              <input
                value={rootCause}
                onChange={(e) => setRootCause(e.target.value)}
                placeholder="e.g. Industrial action resolved, throughput restored"
                style={{ width: '100%', fontSize: 12, padding: '8px 10px', borderRadius: 6, border: `1px solid ${c.border}`, boxSizing: 'border-box', background: c.surfaceSubtle, color: c.textPrimary }}
              />
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--clt-grey-500)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 5 }}>
                Resolution Notes (optional)
              </label>
              <textarea
                value={resolveNotes}
                onChange={(e) => setResolveNotes(e.target.value)}
                placeholder="Post-incident actions, lessons learned, follow-up tasks…"
                rows={3}
                style={{ width: '100%', fontSize: 12, padding: '8px 10px', borderRadius: 6, border: `1px solid ${c.border}`, resize: 'none', fontFamily: 'inherit', boxSizing: 'border-box', background: c.surfaceSubtle, color: c.textPrimary }}
              />
            </div>
            <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', marginBottom: 16 }}>
              Resolving as <b>{userEmail}</b>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowResolveModal(false)}>Cancel</button>
              <button
                className="btn btn-sm"
                style={{ background: rootCause.trim() ? '#059669' : '#D1FAE5', color: '#fff', border: 'none' }}
                disabled={!rootCause.trim() || resolving}
                onClick={() => { onResolve(rootCause.trim(), resolveNotes || undefined); setShowResolveModal(false) }}
              >
                {resolving ? 'Resolving…' : <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle size={12} /> Confirm Resolution</span>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Exception list row ───────────────────────────────────────────────────────

function ExcRow({ exc, selected, onSelect, hasPlan = false }: {
  exc: any; selected: any; onSelect: (e: any) => void; hasPlan?: boolean
}) {
  const { c } = useTheme()
  const isSelected = selected?.exception_code === exc.exception_code
  const pc = PRIORITY_COLOR[exc.priority] || '#6B7280'
  const borderColor = exc.status === 'open' ? pc
    : exc.status === 'resolved' ? '#10B981'
    : 'var(--clt-grey-300)'

  return (
    <div onClick={() => onSelect(exc)}
      data-tour="exc-row"
      style={{
        display: 'flex', gap: 12, padding: '12px 16px', cursor: 'pointer',
        borderLeft: `4px solid ${borderColor}`,
        background: isSelected ? c.info.bg : c.surface,
        borderTop: `1px solid ${c.borderSubtle}`,
        transition: 'background 100ms',
      }}
      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = c.surfaceSubtle }}
      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = c.surface }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, width: 38, flexShrink: 0 }}>
        <span className={`badge badge-${exc.priority.toLowerCase()}`}>{exc.priority}</span>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: exc.status === 'open' ? pc
            : exc.status === 'resolved' ? '#10B981'
            : '#F59E0B',
        }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--clt-grey-900)', lineHeight: 1.4, marginBottom: 3 }}>
          {exc.title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', marginBottom: exc.automated_action_taken ? 4 : 0 }}>
          {exc.category?.replace(/_/g, ' ')}
          {exc.impacted_engineer_count > 0 && <> · {exc.impacted_engineer_count} engineers</>}
          {exc.recurrence_count > 1 && <span style={{ color: 'var(--clt-amber)', marginLeft: 6 }}>↻ {exc.recurrence_count}×</span>}
        </div>
        {exc.automated_action_taken && (
            <div style={{ fontSize: 11, color: 'var(--status-success-text)', lineHeight: 1.4, display: 'flex', gap: 4, alignItems: 'flex-start' }}>
              <Check size={10} style={{ marginTop: 2, flexShrink: 0 }} />
              <span>{exc.automated_action_taken.length > 80 ? exc.automated_action_taken.slice(0, 80) + '…' : exc.automated_action_taken}</span>
            </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
        <StatusBadge exc={exc} />
        {hasPlan && (
          <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 10, background: 'var(--status-ai-bg)', color: 'var(--status-ai-text)', border: '1px solid var(--status-ai-border)', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 3 }}>
            <Sparkles size={9} /> AI Plan
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function StatusBadge({ exc }: { exc: any }) {
  const { c } = useTheme()
  const s: React.CSSProperties = { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 }
  if (exc.status === 'open')
    return <span style={{ ...s, background: c.danger.bg, color: c.danger.text, border: `1px solid ${c.danger.border}` }}>Open</span>
  if (exc.status === 'acknowledged')
    return <span style={{ ...s, background: c.warning.bg, color: c.warning.text, border: `1px solid ${c.warning.border}` }}>Acknowledged</span>
  if (exc.status === 'resolved')
    return <span style={{ ...s, background: c.success.bg, color: c.success.text, border: `1px solid ${c.success.border}` }}>Resolved</span>
  return <span className="badge badge-grey">{exc.status}</span>
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--clt-grey-400)', marginBottom: 6 }}>
      {children}
    </div>
  )
}

function Stat({ label, value, alert = false }: { label: string; value: any; alert?: boolean }) {
  const { c } = useTheme()
  return (
    <div style={{ background: alert ? c.danger.bg : c.surfaceSubtle, borderRadius: 6, padding: '8px 10px', border: `1px solid ${alert ? c.danger.border : c.border}` }}>
      <div style={{ fontSize: 11, color: alert ? c.danger.text : c.textMuted, marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 16, color: alert ? c.danger.text : c.textPrimary }}>{value}</div>
    </div>
  )
}
