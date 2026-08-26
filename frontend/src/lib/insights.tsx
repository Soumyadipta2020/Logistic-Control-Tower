// The executive insight engine — KPI metadata, the narrative summary and the
// three-horizon recommendation plan.
//
// This lives outside DashboardPage because the panel it feeds now renders inside
// the AI Command Center rather than on the dashboard: the reasoning about what
// the network state means, and what to do about it, belongs with the rest of the
// agentic layer. The dashboard keeps the status banner and the KPI grid — the
// facts — and links across to ATLAS for the interpretation.

// ─── formatting ───────────────────────────────────────────────────────────────

export function fmtMoney(v: number): string {
  if (v == null) return '—'
  const n = Math.abs(v)
  if (n >= 1_000_000) return `£${(v / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `£${(v / 1_000).toFixed(0)}k`
  return `£${Math.round(v)}`
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export const LOWER_IS_BETTER = new Set([
  'expediting_cost_pct', 'scope3_ytd_tco2e', 'p1_response_time_min', 'cost_per_install_gbp',
  'sla_breach_rate_pct', 'inventory_working_capital_gbp', 'inventory_value_at_risk_gbp', 'excess_stock_gbp',
  // Cross-module: today's appointments in SLA jeopardy (see /analytics/jobs-at-risk)
  'jobs_at_sla_risk',
])

export const RAG_ACCENT = { G: '#10B981', A: '#F59E0B', R: '#EF4444' }

export const KPI_META: Record<string, { label: string; unit: string; description: string; primary: boolean }> = {
  first_time_fix_rate: { label: 'First Time Fix Rate', unit: '%', description: 'Jobs resolved without a return visit', primary: true },
  p1_response_time_min: { label: 'P1 Response Time', unit: 'min', description: 'Time to first response on P1 exceptions', primary: true },
  expediting_cost_pct: { label: 'Expediting Cost', unit: '%', description: 'Emergency procurement as % of total spend', primary: true },
  supplier_otif: { label: 'Supplier OTIF', unit: '%', description: 'On-Time-In-Full delivery rate across all suppliers', primary: false },
  landfill_diversion_pct: { label: 'Landfill Diversion', unit: '%', description: 'Parts diverted from landfill via reconditioning', primary: false },
  scope3_ytd_tco2e: { label: 'Scope 3 YTD', unit: 'tCO₂e', description: 'Year-to-date Scope 3 carbon emissions', primary: false },
  inventory_accuracy_pct: { label: 'Inventory Accuracy', unit: '%', description: 'Accuracy of stock records vs physical counts', primary: false },
  cost_per_install_gbp: { label: 'Cost per Install', unit: '£', description: 'Average end-to-end cost for equipment installation', primary: false },
  sla_breach_rate_pct: { label: 'SLA Breach Rate', unit: '%', description: 'Percentage of jobs missing agreed SLA', primary: true },
  // Demand & Inventory financial lens — the working-capital story the module tells
  inventory_working_capital_gbp: { label: 'Inventory Capital', unit: '£', description: 'Cash tied up in stock across the network', primary: true },
  inventory_turns: { label: 'Inventory Turns', unit: '×', description: 'Times the stockholding sells through per year', primary: false },
  gmroi: { label: 'GMROI', unit: '×', description: 'Gross margin returned per £ invested in stock', primary: false },
  inventory_value_at_risk_gbp: { label: 'Value at Risk', unit: '£', description: 'Replenishment spend needed to rescue critical SKUs', primary: true },
  excess_stock_gbp: { label: 'Excess Stock', unit: '£', description: 'Capital held above the order-up-to target', primary: false },
}

export const KPI_MODULE: Record<string, { module: string; route: string }> = {
  first_time_fix_rate:           { module: 'Live Field Ops', route: '/visibility' },
  p1_response_time_min:          { module: 'Exceptions', route: '/exceptions' },
  sla_breach_rate_pct:           { module: 'Exceptions', route: '/exceptions' },
  expediting_cost_pct:           { module: 'Demand & Inventory', route: '/demand' },
  inventory_accuracy_pct:        { module: 'Demand & Inventory', route: '/demand' },
  inventory_working_capital_gbp: { module: 'Demand & Inventory', route: '/demand' },
  inventory_turns:               { module: 'Demand & Inventory', route: '/demand' },
  gmroi:                         { module: 'Demand & Inventory', route: '/demand' },
  inventory_value_at_risk_gbp:   { module: 'Demand & Inventory', route: '/demand' },
  excess_stock_gbp:              { module: 'Demand & Inventory', route: '/demand' },
  supplier_otif:                 { module: 'Supplier & Labour Risk', route: '/risk' },
  landfill_diversion_pct:        { module: 'Sustainability', route: '/sustainability' },
  scope3_ytd_tco2e:              { module: 'Sustainability', route: '/sustainability' },
  cost_per_install_gbp:          { module: 'Transport Control', route: '/transport' },
}

// ─── recommendation rendering ─────────────────────────────────────────────────
// A recommendation is only actionable to a senior reader if it says who owns it,
// by when, and what it is worth. Actions are objects carrying that; plain strings
// are still supported so any legacy plan keeps rendering.

export function HorizonHeader({ tone, title, window: win, note }: {
  tone: string; title: string; window: string; note: string
}) {
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: tone, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{win}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>{note}</div>
    </div>
  )
}

export function ActionRow({ step, n, tone, compact }: { step: any; n?: number; tone: string; compact?: boolean }) {
  const isObj = step && typeof step === 'object'
  const text = isObj ? step.action : step
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: compact ? 7 : 0 }}>
      {n != null ? (
        <span style={{
          fontSize: 11, fontWeight: 900, minWidth: 18, height: 18, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: tone, color: '#fff', flexShrink: 0, marginTop: 1,
        }}>{n}</span>
      ) : (
        <span style={{ color: tone, flexShrink: 0, lineHeight: 1.5, fontSize: 11.5 }}>•</span>
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: compact ? 11.5 : 12, lineHeight: 1.45, color: 'var(--text-secondary)' }}>{text}</div>
        {isObj && (step.owner || step.by || step.impact) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 3, alignItems: 'center' }}>
            {step.owner && (
              <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 10, background: 'var(--bg-muted)', color: 'var(--text-secondary)' }}>
                {step.owner}
              </span>
            )}
            {step.by && (
              <span style={{ fontSize: 11, fontWeight: 800, padding: '1px 6px', borderRadius: 10, background: `${tone}18`, color: tone }}>
                {step.by}
              </span>
            )}
            {step.impact && (
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                {step.impact}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── AI Insight generation ────────────────────────────────────────────────────

export interface RecAction {
  action: string
  owner: string
  by: string
  impact?: string
}

export interface Insight {
  scenario: string
  label: string
  labelColor: string
  confidence: number
  recs: RecAction[]
  short_term?: RecAction[]
  long_term?: RecAction[]
  // With no incident running, a three-horizon action plan is noise. The panel
  // becomes a readout plus a way through to whatever is off-track.
  summaryOnly?: boolean
  attention?: { key: string; label: string; value: string; target: string; rag: string; module: string; route: string }[]
}

const R = (action: string, owner: string, by: string, impact?: string): RecAction => ({ action, owner, by, impact })

export function generateInsights(params: {
  systemRag: 'G' | 'A' | 'R'
  openP1: any[]
  openP2: any[]
  kpis: any
  invAtRisk: number
  invStockouts: number
  avgDoS: number
  fillRate: number
  warehouses: any[]
  fin?: any
  work?: any
}): Insight {
  const { openP1, openP2, kpis, invAtRisk } = params

  if (openP1.length > 0) {
    const exc = openP1[0]
    return {
      scenario: 'P1 INCIDENT ACTIVE',
      label: 'Immediate action required',
      labelColor: '#EF4444',
      confidence: 94,
      recs: [
        R(`Escalate "${exc.title}" to the Field Operations Lead`, 'Field Ops Director', 'T+30 min', 'SLA resolution target'),
        exc.impacted_engineer_count > 0
          ? R(`Redeploy the ${Math.min(exc.impacted_engineer_count, 3)} nearest engineers from adjacent postcodes into the impact zone`, 'Field Dispatch', 'T+1h', `Covers ${exc.impacted_engineer_count} affected engineers`)
          : R('Activate the nearest field team and open the P1 communication protocol', 'Field Dispatch', 'T+15 min', 'Contains customer impact'),
        R('Open this exception in Risk Management and work its response plan step by step', 'Duty Manager', 'Now', 'Plan is pre-approved'),
        R(`Prepare customer comms for SLA impact — first-time fix at ${kpis?.first_time_fix_rate?.value?.toFixed(1) ?? '—'}%`, 'Customer Ops', 'T+2h', 'Protects trust ahead of the miss'),
      ],
    }
  }

  if (openP2.length >= 2) {
    return {
      scenario: 'MULTIPLE P2 EXCEPTIONS',
      label: 'Proactive intervention recommended',
      labelColor: '#F97316',
      confidence: 81,
      recs: [
        R(`Assign a named resolution owner to each of the ${openP2.length} open P2 exceptions`, 'Duty Manager', 'T+1h', 'Prevents drift into P1'),
        invAtRisk > 0
          ? R(`Audit the ${invAtRisk.toLocaleString()} at-risk SKUs at the NDC — parts may be driving the exception volume`, 'Inventory Analyst', 'Same day', 'Tests the parts hypothesis')
          : R('Inventory is healthy, so treat these as capacity or logistics issues rather than parts-driven', 'Duty Manager', 'Same day', 'Focuses effort correctly'),
        R(`Confirm late supplier deliveries are not compounding the backlog — OTIF at ${kpis?.supplier_otif?.value?.toFixed(1) ?? '—'}%`, 'Supplier Manager', 'Same day', 'Rules out inbound cause'),
        R('Work each P2 through its response plan in Risk Management', 'Duty Manager', 'This shift', 'Plans are pre-approved'),
      ],
    }
  }

  // ── No incident running. An action plan would be noise here, so the panel
  // reports the state and hands off to the module that owns anything off-track.
  const attention = (kpis ? Object.entries(kpis) : [])
    .filter(([, v]: any) => v.rag === 'A' || v.rag === 'R')
    .sort(([, a]: any, [, b]: any) => (a.rag === 'R' ? 0 : 1) - (b.rag === 'R' ? 0 : 1))
    .map(([key, v]: any) => {
      const meta = KPI_META[key]
      const mod = KPI_MODULE[key]
      const unit = meta?.unit === '£' ? '' : (meta?.unit ?? '')
      const fmt = (n: number) => (meta?.unit === '£' ? fmtMoney(n) : `${Number(n).toFixed(1)}${unit}`)
      return {
        key,
        label: meta?.label ?? key,
        value: fmt(v.value),
        target: fmt(v.target),
        rag: v.rag,
        module: mod?.module ?? 'Analytics',
        route: mod?.route ?? '/',
      }
    })

  const reds = attention.filter(a => a.rag === 'R')
  return {
    scenario: reds.length ? 'KPIS OFF TRACK' : (attention.length ? 'KPIS TRENDING' : 'OPERATIONS NORMAL'),
    label: reds.length ? 'Review the modules below' : (attention.length ? 'Trend monitoring active' : 'No action required'),
    labelColor: reds.length ? '#EF4444' : (attention.length ? '#F59E0B' : '#10B981'),
    confidence: reds.length ? 88 : 76,
    recs: [],
    summaryOnly: true,
    attention,
  }
}

// ─── ATLAS posture ────────────────────────────────────────────────────────────
// Half of the current state is the agentic layer's own doing. A readout that
// describes the network as though nobody had touched it is incomplete and can be
// actively misleading — an amber KPI that ATLAS already raised a PO against is a
// different situation from one nothing has been done about. So the panel reads
// two more things alongside the operational state: what ATLAS has already
// executed, and what it deliberately stopped and handed to a human.

export const SEV_META: Record<string, { label: string; color: string; rank: number }> = {
  critical:    { label: 'Critical',    color: '#EF4444', rank: 0 },
  high:        { label: 'High',        color: '#F97316', rank: 1 },
  medium:      { label: 'Medium',      color: '#F59E0B', rank: 2 },
  low:         { label: 'Low',         color: '#64748B', rank: 3 },
  opportunity: { label: 'Opportunity', color: '#8B5CF6', rank: 4 },
}

export interface AtlasPosture {
  /** Executed by ATLAS with no human in the loop, last 24h. */
  auto: number
  /** Proposed by ATLAS, approved by a human, then executed, last 24h. */
  approved: number
  /** auto + approved — everything the agentic layer put through in the last 24h. */
  handled: number
  recent: { title: string; kind: string; ts: string; module_label?: string }[]
  pending: number
  criticalPending: number
  valueAtStake: number
  oldestPending: string | null
  topPending: { id: string; title: string; severity: string; module_label?: string; value_gbp?: number }[]
  /** Decisions and line items differ: 11 decisions can commit 71 orders. */
  pendingItems: number
}

const DAY_MS = 86_400_000

// Counts come off the same capped activity feed the Automated and Audit tabs read,
// not off `fleet.metrics`. The metrics are a calendar-day count and would drift
// from the rolling 24h window shown here — and the number in this panel must equal
// the number on the tab its "View all" opens, or one of them is lying.
export function atlasPostureFrom(activity: any[], recs: any[]): AtlasPosture {
  const acts = activity ?? []
  const pend = recs ?? []

  // Operator entries are in the same audit feed but were performed by a person on
  // a module screen — they are not ATLAS's work and must not be counted as it.
  const done = acts.filter((e: any) =>
    e?.ts && (e.kind === 'auto' || e.kind === 'approved') && Date.now() - new Date(e.ts).getTime() <= DAY_MS)

  const bySeverity = [...pend].sort((a, b) =>
    (SEV_META[a.severity]?.rank ?? 9) - (SEV_META[b.severity]?.rank ?? 9) || (b.value_gbp ?? 0) - (a.value_gbp ?? 0))

  return {
    auto: done.filter((e: any) => e.kind === 'auto').length,
    approved: done.filter((e: any) => e.kind === 'approved').length,
    handled: done.length,
    recent: done.slice(0, 3).map((e: any) => ({ title: e.title, kind: e.kind, ts: e.ts, module_label: e.module_label })),
    pending: pend.length,
    criticalPending: pend.filter((r: any) => r.severity === 'critical' || r.severity === 'high').length,
    valueAtStake: pend.reduce((s: number, r: any) => s + (r.value_gbp ?? 0), 0),
    oldestPending: pend.length
      ? [...pend].sort((a: any, b: any) => +new Date(a.created_at ?? 0) - +new Date(b.created_at ?? 0))[0].created_at ?? null
      : null,
    topPending: bySeverity.slice(0, 3).map((r: any) => ({
      id: r.id, title: r.title, severity: r.severity, module_label: r.module_label, value_gbp: r.value_gbp,
    })),
    pendingItems: pend.reduce((s: number, r: any) => s + (r.batch?.count ?? 1), 0),
  }
}

// One sentence on what the agentic layer has done and what it is holding. Appended
// to the executive summary so the narrative covers the whole picture — state, plus
// the response already under way, plus what is blocked on a human.
export function atlasNarrative(p: AtlasPosture): string {
  const parts: string[] = []

  if (p.handled === 0) {
    parts.push('ATLAS has executed nothing in the last 24 hours.')
  } else {
    const split = p.auto > 0 && p.approved > 0
      ? `${p.auto} on its own and ${p.approved} after your approval`
      : p.auto > 0 ? 'all of them autonomously within guardrails' : 'all of them after your approval'
    parts.push(`ATLAS has already executed ${p.handled} action${p.handled === 1 ? '' : 's'} in the last 24 hours — ${split}.`)
  }

  if (p.pending === 0) {
    parts.push('Nothing is waiting on your approval.')
  } else {
    const items = p.pendingItems !== p.pending ? ` covering ${p.pendingItems} items` : ''
    const value = p.valueAtStake > 0 ? `, ${fmtMoney(p.valueAtStake)} at stake` : ''
    const sev = p.criticalPending > 0 ? ` — ${p.criticalPending} critical or high` : ''
    parts.push(`${p.pending} decision${p.pending === 1 ? '' : 's'}${items} ${p.pending === 1 ? 'is' : 'are'} held for you${value}${sev}.`)
  }

  return parts.join(' ')
}

// AI narrative summary — a plain-English readout of the whole operation,
// rebuilt from live data on every refresh.
export function generateSummary(params: {
  systemRag: 'G' | 'A' | 'R'
  ragCounts: Record<string, number>
  openP1: any[]
  openP2: any[]
  openCount: number
  invAtRisk: number
  invStockouts: number
  avgDoS: number
  fillRate: number
  warehouses: any[]
  kpis: any
  atlas?: AtlasPosture
}): string {
  const { systemRag, ragCounts, openP1, openP2, openCount, invAtRisk, invStockouts, avgDoS, fillRate, warehouses, kpis, atlas } = params
  const degraded = warehouses.filter((w: any) => w.throughput_vs_baseline_pct < 75)
  const parts: string[] = []

  if (systemRag === 'R') {
    parts.push(openP1.length > 0
      ? `The network is in a critical state: ${openP1.length} P1 incident${openP1.length > 1 ? 's are' : ' is'} active (“${openP1[0].title}”) with ${openCount} exceptions open overall.`
      : `The network is in a critical state with ${ragCounts.R} KPI${ragCounts.R > 1 ? 's' : ''} red and ${openCount} open exceptions.`)
  } else if (systemRag === 'A') {
    parts.push(`The network is under pressure but contained: ${ragCounts.A} KPI${ragCounts.A > 1 ? 's are' : ' is'} amber, ${openCount} exception${openCount === 1 ? '' : 's'} open (${openP2.length} at P2), and no P1 incidents.`)
  } else {
    parts.push(`Operations are running normally: all ${ragCounts.G} tracked KPIs are green and no P1 or P2 incidents are open.`)
  }

  if (degraded.length > 0) {
    parts.push(`Warehouse throughput is degraded at ${degraded.map((w: any) => w.code).join(' and ')} (${degraded.map((w: any) => `${w.throughput_vs_baseline_pct.toFixed(0)}%`).join(', ')} of baseline).`)
  }

  if (invStockouts > 0) {
    parts.push(`Inventory needs attention: ${invStockouts} SKU${invStockouts > 1 ? 's are' : ' is'} stocked out and ${invAtRisk} at risk, with ${avgDoS.toFixed(1)} days of supply on average.`)
  } else if (invAtRisk > 0) {
    parts.push(`Inventory is broadly healthy at ${fillRate.toFixed(0)}% fill rate, though ${invAtRisk} SKU${invAtRisk > 1 ? 's sit' : ' sits'} below their comfort threshold.`)
  } else {
    parts.push(`Inventory is healthy — ${fillRate.toFixed(0)}% fill rate and ${avgDoS.toFixed(1)} days of average supply.`)
  }

  const ftfr = kpis?.first_time_fix_rate?.value
  const otif = kpis?.supplier_otif?.value
  if (ftfr != null && otif != null) {
    parts.push(`First-time fix is at ${ftfr.toFixed(1)}% and supplier OTIF at ${otif.toFixed(1)}%.`)
  }

  // What the agentic layer has already done about all of the above. It goes before
  // the closing line because the recommendation only makes sense once the reader
  // knows what has and has not already been handled.
  if (atlas) parts.push(atlasNarrative(atlas))

  // The closing line must match what is actually shown below it. With no incident
  // running there is no action list, so pointing at one would be wrong.
  const incidentLive = openP1.length > 0 || openP2.length >= 2
  const queued = (atlas?.pending ?? 0) > 0
  if (incidentLive) {
    parts.push(systemRag === 'R'
      ? 'Recommend executing the actions below immediately and reviewing progress every 30 minutes.'
      : 'Recommend actioning the items below this shift to stop the amber indicators trending red.')
  } else if (ragCounts.R > 0 || ragCounts.A > 0) {
    parts.push('No incident is open — the KPIs below are outside tolerance and can be opened in the module that owns them.')
  } else if (queued) {
    // "Nothing to decide" would be false while ATLAS is holding decisions, even
    // with every KPI green — the queue is exactly what needs a decision.
    parts.push('No incident is open and every KPI is inside tolerance; the only thing needing a decision is the approval queue.')
  } else {
    parts.push('No incident is open and every KPI is inside tolerance; nothing requires a decision right now.')
  }

  return parts.join(' ')
}

// The RAG roll-up the status banner and the insight panel must agree on.
// CRITICAL means an active incident or a compounding failure — a P1, or 2+ KPIs
// off-target — not a single metric sitting below its own bar.
export function systemRagFrom(kpiEntries: [string, any][], openP1: any[]) {
  const counts: Record<string, number> = { G: 0, A: 0, R: 0 }
  kpiEntries.forEach(([, v]: any) => { if (v.rag) counts[v.rag] = (counts[v.rag] || 0) + 1 })
  const rag: 'G' | 'A' | 'R' =
    openP1.length > 0 || counts.R >= 2 ? 'R'
      : counts.R >= 1 || counts.A > 0 ? 'A'
        : 'G'
  return { ragCounts: counts, systemRag: rag }
}
