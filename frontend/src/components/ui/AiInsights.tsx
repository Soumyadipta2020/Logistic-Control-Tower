// AI Insights & Recommendations.
//
// This used to live on the Executive Dashboard, wedged under the status banner.
// It belongs here instead: the dashboard reports the FACTS (status, KPI grid,
// module rollups) and ATLAS supplies the INTERPRETATION — what the state means,
// what to do about it, and over what horizon. Splitting them that way stops the
// dashboard competing with the agentic layer to be the place you go for "so
// what do I do?", and lets the panel sit next to the approvals it will produce.
//
// It answers three questions in order, and all three are needed for any of them
// to be honest:
//
//   1. WHERE ARE WE      — the live operational state: KPI RAG, exceptions,
//                          inventory, warehouse throughput, or the researched
//                          risk plan if a simulator scenario is running.
//   2. WHAT WAS DONE     — what ATLAS has already executed in the last 24h, split
//                          by whether it ran autonomously or after an approval.
//   3. WHAT IS BLOCKED   — the decisions ATLAS deliberately stopped and is
//                          holding for a human, with the value riding on them.
//
// Reporting (1) alone was the original flaw: it described the network as though
// nothing had been done about it, so an amber KPI already covered by an executed
// PO read identically to one nobody had touched, and "nothing needs a decision"
// could appear while decisions sat queued one tab across.
//
// The component owns its own data so it can be dropped anywhere in the AI panel
// without a parent having to thread a dozen props through.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Sparkles, ArrowRight, ShieldCheck, Zap, UserCheck, Check } from 'lucide-react'
import {
  fetchExecutiveKPIs, fetchExceptions, fetchWarehouseHealth,
  fetchInventorySummary, fetchActiveScenario,
  fetchAgentRecommendations, fetchAgentActivity,
} from '../../lib/api'
import {
  KPI_META, RAG_ACCENT, SEV_META, ActionRow, HorizonHeader,
  generateInsights, generateSummary, systemRagFrom, atlasPostureFrom, atlasNarrative,
  fmtMoney, timeAgo, type Insight,
} from '../../lib/insights'
import { useTheme } from '../../hooks/useTheme'

// The anchor the dashboard's "AI Insights" pill scrolls to.
export const AI_INSIGHTS_ANCHOR = 'ai-insights'

export function AiInsightsPanel({ onOpenModule, onOpenView }: {
  onOpenModule?: (route: string) => void
  // Lets the panel hand off into the Approvals and Automated tabs. Optional so the
  // component still drops anywhere — outside the AI panel the hand-offs go away
  // rather than dead-ending on a tab that is not on screen.
  onOpenView?: (view: string) => void
}) {
  const { c } = useTheme()
  const navigate = useNavigate()
  const go = (route: string) => (onOpenModule ? onOpenModule(route) : navigate(route))

  const { data: kpis } = useQuery({ queryKey: ['executive-kpis'], queryFn: fetchExecutiveKPIs, refetchInterval: 30_000 })
  const { data: exceptions } = useQuery({ queryKey: ['exceptions-page'], queryFn: () => fetchExceptions(), refetchInterval: 15_000 })
  const { data: warehouseHealth } = useQuery({ queryKey: ['warehouse-health'], queryFn: fetchWarehouseHealth, refetchInterval: 30_000 })
  const { data: inventorySummary } = useQuery({ queryKey: ['inventory-summary', {}], queryFn: () => fetchInventorySummary(), refetchInterval: 60_000 })
  const { data: activeScn } = useQuery({ queryKey: ['active-scenario'], queryFn: fetchActiveScenario, refetchInterval: 15_000 })

  // The agentic half of the current state. These reuse the AI panel's own query
  // keys, so when the panel is mounted inside it the data is shared rather than
  // refetched — and the numbers here can never disagree with the tabs they link to.
  const { data: agentRecs = [] } = useQuery({
    queryKey: ['agent-recs', 'all'], queryFn: () => fetchAgentRecommendations(), refetchInterval: 15_000,
  })
  const { data: agentActivity = [] } = useQuery({
    queryKey: ['agent-activity'], queryFn: () => fetchAgentActivity(100), refetchInterval: 20_000,
  })
  const atlas = useMemo(() => atlasPostureFrom(agentActivity, agentRecs), [agentActivity, agentRecs])

  const allExceptions = useMemo(() => exceptions?.items ?? [], [exceptions])
  const openExceptions = useMemo(() => allExceptions.filter((e: any) => e.status === 'open'), [allExceptions])
  const openP1 = useMemo(() => openExceptions.filter((e: any) => e.priority === 'P1'), [openExceptions])
  const openP2 = useMemo(() => openExceptions.filter((e: any) => e.priority === 'P2'), [openExceptions])
  const warehouses = useMemo(() => warehouseHealth?.warehouses ?? [], [warehouseHealth])

  const kpiEntries = useMemo(() => (kpis ? Object.entries(kpis) : []) as [string, any][], [kpis])
  const kpiCards = useMemo(() => kpiEntries.filter(([k]) => KPI_META[k]), [kpiEntries])
  const { ragCounts, systemRag } = useMemo(() => systemRagFrom(kpiEntries, openP1), [kpiEntries, openP1])

  const invAtRisk = inventorySummary?.at_risk ?? 0
  const invStockouts = inventorySummary?.stockouts ?? 0
  const avgDoS = inventorySummary?.avg_days_of_supply ?? 0
  const fillRate = inventorySummary?.fill_rate_pct ?? 100

  // When a simulator scenario is active its researched risk plan drives the
  // panel; otherwise the insight is generated from live operational state.
  const scenarioPlan = activeScn?.scenario_id ? activeScn.risk_plan : null
  // The exception carrying this scenario's plan — lets the panel reflect whether
  // the plan has actually been activated (and by whom), not just that one exists.
  const activeExc = useMemo(
    () => activeScn?.scenario_id ? allExceptions.find((e: any) => e.scenario_id === activeScn.scenario_id) : null,
    [allExceptions, activeScn]
  )

  const insight: Insight = useMemo(() => {
    if (scenarioPlan) {
      const levelColor: Record<string, string> = { Critical: '#EF4444', High: '#F97316', Medium: '#F59E0B', Low: '#10B981' }
      return {
        scenario: `SCENARIO: ${String(activeScn.name).toUpperCase()}`,
        label: `${scenarioPlan.risk_level} risk — response plan active`,
        labelColor: levelColor[scenarioPlan.risk_level] ?? '#F59E0B',
        confidence: 92,
        recs: [],
      }
    }
    try {
      return generateInsights({ systemRag, openP1, openP2, kpis: kpis ?? {}, invAtRisk, invStockouts, avgDoS, fillRate, warehouses })
    } catch {
      return { scenario: 'OPERATIONS NORMAL', label: 'Optimisation opportunity', labelColor: '#10B981', confidence: 72, recs: [] }
    }
  }, [scenarioPlan, activeScn, systemRag, openP1, openP2, kpis, invAtRisk, invStockouts, avgDoS, fillRate, warehouses])

  const aiSummary = useMemo(() => {
    if (scenarioPlan) {
      const modules = (activeScn.affected_modules ?? []).join(', ')
      // A scenario narrative that stopped at the researched plan would read as if
      // nothing had happened yet, while ATLAS was already working the response.
      return `${scenarioPlan.summary}${modules ? ` Impact is visible across: ${modules}.` : ''} ${atlasNarrative(atlas)}`
    }
    try {
      return generateSummary({
        systemRag, ragCounts, openP1, openP2, openCount: openExceptions.length,
        invAtRisk, invStockouts, avgDoS, fillRate, warehouses, kpis: kpis ?? {}, atlas,
      })
    } catch {
      return 'Live operational summary is being generated…'
    }
  }, [scenarioPlan, activeScn, systemRag, ragCounts, openP1, openP2, openExceptions, invAtRisk, invStockouts, avgDoS, fillRate, warehouses, kpis, atlas])

  return (
    <section id={AI_INSIGHTS_ANCHOR} className="card ai-insights" style={{ scrollMarginTop: 16 }}>
      {/* Header — neutral surface so it reads as analysis, not alarm */}
      <div className="ai-insights-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Sparkles size={15} color="#FB4E0B" />
          <div style={{ minWidth: 0 }}>
            <div className="ai-insights-title">AI Insights &amp; Recommendations</div>
            <div className="ai-insights-sub">
              {kpiCards.length > 0 ? (() => {
                const redKpis = kpiCards.filter(([, v]: any) => v.rag === 'R').map(([k]: any) => KPI_META[k]?.label ?? k)
                const amberKpis = kpiCards.filter(([, v]: any) => v.rag === 'A').map(([k]: any) => KPI_META[k]?.label ?? k)
                const greenCount = kpiCards.filter(([, v]: any) => v.rag === 'G').length
                if (redKpis.length > 0) return <><span style={{ fontWeight: 700, color: RAG_ACCENT.R }}>Critical: {redKpis.slice(0, 2).join(', ')}{redKpis.length > 2 ? ` +${redKpis.length - 2} more` : ''}</span>{amberKpis.length > 0 && <span> · {amberKpis.length} at risk</span>}</>
                if (amberKpis.length > 0) return <><span style={{ fontWeight: 700, color: RAG_ACCENT.A }}>At risk: {amberKpis.slice(0, 2).join(', ')}{amberKpis.length > 2 ? ` +${amberKpis.length - 2} more` : ''}</span><span> · {greenCount} healthy</span></>
                return <span style={{ fontWeight: 700, color: RAG_ACCENT.G }}>All {greenCount} KPIs healthy</span>
              })() : <span>{insight.scenario} · {insight.confidence}% confidence</span>}
            </div>
          </div>
        </div>
        <span className="ai-insights-label" style={{
          background: `${insight.labelColor}18`, color: insight.labelColor,
          border: `1px solid ${insight.labelColor}40`,
        }}>
          {insight.label}
        </span>
      </div>

      {/* Executive summary narrative */}
      <div className="ai-insights-summary">
        <div className="ai-insights-eyebrow">Executive Summary</div>
        <div className="ai-insights-narrative">{aiSummary}</div>
      </div>

      {/* The agentic ledger: what ATLAS has already put through, and what it
          stopped and handed back. It sits between the state and the advice
          because it is the bridge between them — half of these recommendations
          may already be in flight, and the reader needs to know which half
          before deciding anything. */}
      <div className="ai-insights-atlas">
        <AtlasColumn
          icon={Zap} accent="#8B5CF6" title="Actioned by ATLAS · 24h"
          headline={`${atlas.handled} action${atlas.handled === 1 ? '' : 's'}`}
          meta={[
            atlas.auto > 0 ? `${atlas.auto} autonomous` : null,
            atlas.approved > 0 ? `${atlas.approved} after your approval` : null,
          ].filter(Boolean).join(' · ')}
          empty="Nothing has been executed in the last 24 hours."
          isEmpty={atlas.handled === 0}
          link={onOpenView ? { label: 'View all', onClick: () => onOpenView('automated') } : undefined}
        >
          {atlas.recent.map((e, i) => (
            <AtlasRow
              key={i}
              dot={e.kind === 'auto' ? '#8B5CF6' : '#10B981'}
              badge={e.kind === 'auto' ? 'Auto' : 'Approved'}
              title={e.title}
              meta={[e.module_label, timeAgo(e.ts)].filter(Boolean).join(' · ')}
              onClick={onOpenView ? () => onOpenView('automated') : undefined}
            />
          ))}
        </AtlasColumn>

        <AtlasColumn
          icon={UserCheck} accent="#3B82F6" title="Held for your approval"
          headline={`${atlas.pending} decision${atlas.pending === 1 ? '' : 's'}`}
          meta={[
            atlas.pendingItems !== atlas.pending ? `${atlas.pendingItems} items` : null,
            atlas.criticalPending > 0 ? `${atlas.criticalPending} critical/high` : null,
            atlas.valueAtStake > 0 ? `${fmtMoney(atlas.valueAtStake)} at stake` : null,
            atlas.oldestPending ? `oldest ${timeAgo(atlas.oldestPending)}` : null,
          ].filter(Boolean).join(' · ') || 'Everything in policy self-executed'}
          empty="Nothing is waiting on you — routine actions ran inside their guardrails."
          isEmpty={atlas.pending === 0}
          link={onOpenView && atlas.pending > 0 ? { label: 'Review', onClick: () => onOpenView('approvals') } : undefined}
        >
          {atlas.topPending.map((r) => (
            <AtlasRow
              key={r.id}
              dot={SEV_META[r.severity]?.color ?? '#64748B'}
              badge={SEV_META[r.severity]?.label ?? r.severity}
              title={r.title}
              meta={[r.module_label, r.value_gbp ? fmtMoney(r.value_gbp) : null].filter(Boolean).join(' · ')}
              onClick={onOpenView ? () => onOpenView('approvals') : undefined}
            />
          ))}
        </AtlasColumn>
      </div>

      {/* Recommendations: the full risk plan when a scenario is active, otherwise
          rule-based recommendations derived from live state. */}
      {scenarioPlan ? (
        <div style={{ padding: '14px 18px' }}>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--status-danger-text)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
              Immediate — {scenarioPlan.playbook_name} · act now
            </div>
            {scenarioPlan.trigger && (
              <div style={{ fontSize: 11, color: c.textMuted, marginBottom: 8 }}>Trigger: {scenarioPlan.trigger}</div>
            )}
            {activeExc && (
              activeExc.plan_activated ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--status-success-text)', fontWeight: 700, marginBottom: 8 }}>
                  ✓ Activated by {activeExc.plan_activated_by} · {new Date(activeExc.plan_activated_at).toLocaleString('en-GB')}
                </div>
              ) : (
                <button
                  onClick={() => go('/exceptions')}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--status-warning-text)', fontWeight: 700, marginBottom: 8, cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
                >
                  ○ Not yet activated — open the exception to activate this plan
                </button>
              )
            )}
            <div className="ai-insights-actions">
              {scenarioPlan.immediate.map((step: any, i: number) => (
                <ActionRow key={i} step={step} n={i + 1} tone="#EF4444" />
              ))}
            </div>
          </div>

          <div className="ai-insights-horizons">
            {scenarioPlan.short_term?.length > 0 && (
              <div>
                <HorizonHeader tone="#B45309" title="Short Term" window="Days to weeks"
                  note="Stabilise, recover the backlog, hold suppliers to account" />
                {scenarioPlan.short_term.map((step: any, i: number) => (
                  <ActionRow key={i} step={step} tone="#F59E0B" compact />
                ))}
              </div>
            )}
            {scenarioPlan.long_term?.length > 0 && (
              <div>
                <HorizonHeader tone="#047857" title="Long Term" window="Quarters · needs investment"
                  note="Remove the structural cause so it cannot recur" />
                {scenarioPlan.long_term.map((step: any, i: number) => (
                  <ActionRow key={i} step={step} tone="#10B981" compact />
                ))}
              </div>
            )}
          </div>

          {scenarioPlan.kpis_to_watch?.length > 0 && (
            <div className="ai-insights-watch">
              <b>KPIs to watch:</b> {scenarioPlan.kpis_to_watch.join(' · ')}
            </div>
          )}
        </div>
      ) : insight.summaryOnly ? (
        (insight.attention?.length ?? 0) > 0 ? (
          <div style={{ padding: '12px 18px 14px' }}>
            <div className="ai-insights-eyebrow" style={{ marginBottom: 8 }}>
              Needs a look · {insight.attention!.length} KPI{insight.attention!.length === 1 ? '' : 's'} outside tolerance
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {insight.attention!.map((a) => {
                const tone = a.rag === 'R' ? '#EF4444' : '#F59E0B'
                return (
                  <button
                    key={a.key}
                    onClick={() => go(a.route)}
                    title={`Open ${a.module}`}
                    className="ai-insights-attention"
                    style={{ borderLeft: `3px solid ${tone}` }}
                  >
                    <span>
                      <span className="ai-insights-attention-label">{a.label}</span>
                      <span className="ai-insights-attention-meta">{a.value} vs {a.target} target · {a.module}</span>
                    </span>
                    <ArrowRight size={13} color={tone} />
                  </button>
                )
              })}
            </div>
          </div>
        ) : atlas.pending > 0 ? (
          // Green on every KPI does not mean "nothing to do" while ATLAS is
          // holding decisions. The queue IS the outstanding decision, so the
          // all-clear points at it rather than contradicting the panel above.
          <div className="ai-insights-clear">
            <Check size={15} color="#10B981" />
            <span>
              Every tracked KPI is inside tolerance and no exceptions are open — the operation is healthy.
              The only thing outstanding is the {atlas.pending} decision{atlas.pending === 1 ? '' : 's'} ATLAS is holding for you above.
            </span>
          </div>
        ) : (
          <div className="ai-insights-clear">
            <ShieldCheck size={15} color="#10B981" />
            Every tracked KPI is inside tolerance and no exceptions are open. Nothing needs a decision right now.
          </div>
        )
      ) : (
        <>
          <div style={{ padding: '12px 18px 4px' }}>
            <HorizonHeader tone="#B91C1C" title="Act Now" window="This shift"
              note="Contain the risk while it is still cheap to fix" />
            <div className="ai-insights-actions">
              {insight.recs.map((rec, i) => (
                <ActionRow key={i} step={rec} n={i + 1} tone="#FB4E0B" />
              ))}
            </div>
          </div>

          {(insight.short_term?.length || insight.long_term?.length) ? (
            <div className="ai-insights-horizons" style={{ padding: '12px 18px 14px', marginTop: 8, borderTop: `1px solid ${c.borderSubtle}` }}>
              {insight.short_term?.length ? (
                <div>
                  <HorizonHeader tone="#B45309" title="Short Term" window="This quarter" note="Stabilise and recover" />
                  {insight.short_term.map((step, i) => <ActionRow key={i} step={step} tone="#F59E0B" compact />)}
                </div>
              ) : <div />}
              {insight.long_term?.length ? (
                <div>
                  <HorizonHeader tone="#047857" title="Long Term" window="Quarters · needs investment" note="Remove the structural cause" />
                  {insight.long_term.map((step, i) => <ActionRow key={i} step={step} tone="#10B981" compact />)}
                </div>
              ) : <div />}
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

// ─── the agentic ledger ───────────────────────────────────────────────────────
// Two columns of the same shape, deliberately: "what ran" and "what stopped" are
// the two halves of one policy, and reading them side by side is how an operator
// judges whether the autonomy level is set where they want it.

function AtlasColumn({ icon: Icon, accent, title, headline, meta, empty, isEmpty, link, children }: {
  icon: React.ElementType; accent: string; title: string
  headline: string; meta: string; empty: string; isEmpty: boolean
  link?: { label: string; onClick: () => void }
  children?: React.ReactNode
}) {
  return (
    <div className="ai-insights-atlas-col">
      <div className="ai-insights-atlas-head">
        <Icon size={12} color={accent} />
        <span className="ai-insights-atlas-title">{title}</span>
        {link && (
          <button className="ai-insights-atlas-link" style={{ color: accent }} onClick={link.onClick}>
            {link.label} <ArrowRight size={11} />
          </button>
        )}
      </div>
      <div className="ai-insights-atlas-headline" style={{ color: isEmpty ? 'var(--text-tertiary)' : accent }}>
        {headline}
      </div>
      <div className="ai-insights-atlas-meta">{isEmpty ? empty : meta}</div>
      {!isEmpty && <div className="ai-insights-atlas-rows">{children}</div>}
    </div>
  )
}

function AtlasRow({ dot, badge, title, meta, onClick }: {
  dot: string; badge: string; title: string; meta: string; onClick?: () => void
}) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag className="ai-insights-atlas-row" onClick={onClick} {...(onClick ? { type: 'button' as const } : {})}>
      <span className="ai-insights-atlas-badge" style={{ color: dot, background: `${dot}18`, border: `1px solid ${dot}3a` }}>
        {badge}
      </span>
      <span className="ai-insights-atlas-rowtext">
        <span className="ai-insights-atlas-rowtitle">{title}</span>
        {meta && <span className="ai-insights-atlas-rowmeta">{meta}</span>}
      </span>
    </Tag>
  )
}
