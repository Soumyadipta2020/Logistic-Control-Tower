import React, { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '../../hooks/useTheme'
import { useQuery } from '@tanstack/react-query'
import { MetricTip } from '../ui/InfoTooltip'
import { getKPIDef } from '../../lib/kpiDefinitions'
import { useReferenceData } from './useReferenceData'
import type { DemandScope } from '../../lib/api'
import {
  fetchMeio, fetchFinancials, fetchReplenishmentRouting,
  fetchPlannerWorklist, fetchForecastTuningImpact, fetchSopPlan, simulateNetwork,
} from '../../lib/api'
import {
  XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ComposedChart, Bar, Line, Area, ReferenceLine, ReferenceArea, Cell,
  ScatterChart, Scatter,
} from 'recharts'
import {
  Layers3, Boxes, Recycle, CalendarRange, FlaskConical, Activity, PackageX,
  PoundSterling, AlertTriangle, TrendingDown, TrendingUp, ClipboardList,
  Sparkles, Gauge, Network, ClipboardCheck, Info, Route, ArrowRight,
  PackagePlus, ArrowLeftRight, ShieldAlert, Zap, X, CheckCircle2,
} from 'lucide-react'

// ─── shared helpers ─────────────────────────────────────────────────────────

export function fmtGBP(v: number): string {
  if (v == null) return '—'
  const n = Math.abs(v)
  if (n >= 1_000_000) return `${v < 0 ? '-' : ''}£${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${v < 0 ? '-' : ''}£${(n / 1_000).toFixed(0)}k`
  return `${v < 0 ? '-' : ''}£${Math.round(n)}`
}


// Driver-group palette — shared by the forecast waterfall and the signal map
export const DRIVER_COLOR: Record<string, string> = {
  base: '#64748B', seasonality: '#0EA5E9', weather: '#2563EB', iot: '#D97706',
}

/**
 * HelpTip — a discoverable helper affordance. Renders a dotted underline and an
 * ⓘ so users can see that an explanation exists, and only when a definition is
 * actually registered (otherwise the label renders plain, never a dead hint).
 */
export function HelpTip({ tip, children, icon = true }: {
  tip: string; children: React.ReactNode; icon?: boolean
}) {
  const { c } = useTheme()
  if (!getKPIDef(tip)) return <>{children}</>
  return (
    <MetricTip label={tip}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0,
        borderBottom: `1px dotted ${c.textMuted}`,
      }}>
        {children}
        {icon && <Info size={11} color={c.textMuted} style={{ flexShrink: 0 }} />}
      </span>
    </MetricTip>
  )
}

/** Card title with a built-in explainer. */
function CardTitle({ tip, icon: Icon, color, children }: {
  tip: string; icon: React.ElementType; color: string; children: React.ReactNode
}) {
  return (
    <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <Icon size={15} color={color} />
      <HelpTip tip={tip}>{children}</HelpTip>
    </div>
  )
}

const chartTooltipStyle = (c: any) => ({
  fontSize: 11, borderRadius: 8, border: `1px solid ${c.border}`, background: c.surface,
})

/**
 * Shared pager. Every table on this page is a window onto a catalogue of 1000+
 * SKUs, so a silently truncated head ("top 10") hides most of the data. This
 * makes the full set reachable and always states how much there is.
 */
export function TablePager({ page, pages, total, perPage, onPage, label = 'rows', busy }: {
  page: number; pages: number; total: number; perPage: number
  onPage: (p: number) => void; label?: string; busy?: boolean
}) {
  const { c } = useTheme()
  if (!total) return null
  const from = (page - 1) * perPage + 1
  const to = Math.min(page * perPage, total)
  const btn = (disabled: boolean) => ({
    fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 6,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
    background: c.surface, color: c.textSecondary, border: `1px solid ${c.border}`,
  })
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      padding: '7px 14px', borderTop: `1px solid ${c.borderSubtle}`, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 11, color: c.textSecondary, fontVariantNumeric: 'tabular-nums' }}>
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()} {label}
        {busy && <span style={{ color: c.textMuted }}> · updating…</span>}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <button disabled={page <= 1} onClick={() => onPage(1)} style={btn(page <= 1)} aria-label="First page">«</button>
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} style={btn(page <= 1)}>‹ Prev</button>
        <span style={{ fontSize: 11, fontWeight: 700, color: c.textPrimary, padding: '0 4px', fontVariantNumeric: 'tabular-nums' }}>
          {page} / {pages}
        </span>
        <button disabled={page >= pages} onClick={() => onPage(page + 1)} style={btn(page >= pages)}>Next ›</button>
        <button disabled={page >= pages} onClick={() => onPage(pages)} style={btn(page >= pages)} aria-label="Last page">»</button>
      </div>
    </div>
  )
}

/** Compact select used for the per-table sort/filter controls. */
export function MiniSelect({ value, onChange, options, active, title }: {
  value: string; onChange: (v: string) => void
  options: { value: string; label: string }[]; active?: boolean; title?: string
}) {
  const { c } = useTheme()
  return (
    <select value={value} onChange={e => onChange(e.target.value)} title={title}
      style={{
        fontSize: 11, padding: '3px 7px', borderRadius: 6, cursor: 'pointer',
        border: `1px solid ${active ? '#2563EB' : c.border}`, background: c.surface,
        color: active ? '#2563EB' : c.textSecondary, fontWeight: active ? 700 : 400,
      }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

/**
 * Panels used to reserve their space with `return null`, so the page popped and
 * jumped as each query landed — and a failed endpoint silently vanished. These
 * keep the layout stable and always say what is happening.
 */
export function PanelSkeleton({ title, lines = 4, section }: { title: string; lines?: number; section?: boolean }) {
  const { c } = useTheme()
  return (
    <div className={section ? 'card section-gap' : 'card'} aria-busy="true" aria-live="polite">
      <div className="card-header">
        <div className="card-title" style={{ color: c.textMuted }}>{title}</div>
        <span style={{ fontSize: 11, color: c.textMuted }}>loading…</span>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} style={{
            height: 11, borderRadius: 4, background: c.surfaceSubtle,
            width: `${100 - i * 11}%`, opacity: 0.8 - i * 0.09,
          }} />
        ))}
      </div>
    </div>
  )
}

export function PanelError({ title, onRetry, section }: { title: string; onRetry?: () => void; section?: boolean }) {
  const { c } = useTheme()
  return (
    <div className={section ? 'card section-gap' : 'card'} role="alert">
      <div className="card-header">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <AlertTriangle size={15} color={c.danger.text} /> {title}
        </div>
      </div>
      <div className="card-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 12, color: c.textSecondary }}>
          Couldn’t load this panel. The rest of the page is unaffected.
        </span>
        {onRetry && (
          <button onClick={onRetry}
            style={{ fontSize: 11, fontWeight: 700, padding: '4px 11px', borderRadius: 6, cursor: 'pointer', background: c.danger.bg, color: c.danger.text, border: `1px solid ${c.danger.border}` }}>
            Retry
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Plane header (Sense / Position / Execute / Orchestrate / Learn) ─────────

const PLANE_ACCENT: Record<string, string> = {
  SENSE: '#2563EB', POSITION: '#0891B2', EXECUTE: '#4F46E5',
  ORCHESTRATE: '#7C3AED', LEARN: '#B45309',
}

export function PlaneHeader({ plane, title, subtitle, icon: Icon, tip }: {
  plane: string; title: string; subtitle: string; icon: React.ElementType; tip?: string
}) {
  const { c } = useTheme()
  const accent = PLANE_ACCENT[plane] || '#2563EB'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0 8px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28,
        borderRadius: 8, background: `${accent}16`, border: `1.5px solid ${accent}33`, flexShrink: 0,
      }}>
        <Icon size={15} color={accent} strokeWidth={2.2} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.14em', color: accent, fontFamily: 'monospace' }}>{plane}</span>
          <span style={{ fontSize: 14, fontWeight: 800, color: c.textPrimary, letterSpacing: '-0.01em' }}>
            {tip ? <HelpTip tip={tip}>{title}</HelpTip> : title}
          </span>
        </div>
        <div style={{ fontSize: 11, color: c.textSecondary, marginTop: 0 }}>{subtitle}</div>
      </div>
      <div style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${accent}44, transparent)`, marginLeft: 4 }} />
    </div>
  )
}

// ─── State-of-Network band (cockpit summary) ────────────────────────────────

export function StateOfNetworkBand({ stockouts, scope = {} }: { atRisk?: number; stockouts: number; scope?: DemandScope }) {
  const { c } = useTheme()
  const { data: fin } = useQuery({ queryKey: ['demand-financials', scope], queryFn: () => fetchFinancials(scope), refetchInterval: 30_000 })
  const { data: work } = useQuery({ queryKey: ['planner-worklist', scope, 1, 1], queryFn: () => fetchPlannerWorklist(scope, 1, 1), refetchInterval: 30_000 })

  const tiles = [
    { tip: 'Working Capital', label: 'Working capital', value: fmtGBP(fin?.stock_value_gbp ?? 0), sub: `${fin?.working_capital_days ?? '—'}d cover · ${fin?.inventory_turns ?? '—'}× turns`, icon: PoundSterling, accent: '#2563EB' },
    { tip: 'Value at Risk', label: 'Value at risk', value: fmtGBP(fin?.value_at_risk_gbp ?? 0), sub: stockouts > 0 ? `${stockouts} stockout${stockouts !== 1 ? 's' : ''} live` : 'no critical stockouts', icon: AlertTriangle, accent: (fin?.value_at_risk_gbp ?? 0) > 0 ? '#DC2626' : '#059669' },
    { tip: 'Excess Capital', label: 'Excess capital', value: fmtGBP(fin?.excess_value_gbp ?? 0), sub: `${fmtGBP(fin?.annual_holding_cost_gbp ?? 0)}/yr to carry all stock`, icon: Boxes, accent: (fin?.excess_value_gbp ?? 0) > 0 ? '#8B5CF6' : '#059669' },
    { tip: 'GMROI', label: 'GMROI', value: fin?.gmroi != null ? `${fin.gmroi}×` : '—', sub: `${fin?.inventory_turns ?? '—'}× turns · ${fin?.working_capital_days ?? '—'}d capital`, icon: Gauge, accent: '#0891B2' },
    { tip: 'Open Actions', label: 'Open actions', value: String(work?.total ?? work?.items?.length ?? 0), sub: `${work?.critical ?? 0} critical · ${fmtGBP(work?.total_value_at_risk_gbp ?? 0)} at risk`, icon: ClipboardCheck, accent: (work?.critical ?? 0) > 0 ? '#DC2626' : '#059669' },
  ]
  return (
    <div className="auto-grid" style={{
      '--cols': '5', '--col-min': '150px', '--grid-gap': '0px', marginBottom: 12,
      border: `1px solid ${c.border}`, borderRadius: 10, overflow: 'hidden', background: c.surface,
    } as React.CSSProperties}>
      {tiles.map((t) => (
        <MetricTip key={t.label} label={t.tip} block>
          {/* Dividers as a box-shadow, not a border, and on every tile rather
              than all-but-the-last. A shadow paints OUTSIDE the tile, so the one
              that ends up against the strip's edge is clipped by the strip's own
              `overflow: hidden` — which is what keeps the rule correct once the
              strip wraps to two rows. A border is painted inside the box, so the
              tile ending a wrapped row would keep a stub of rule hanging in the
              middle of the card. The second shadow does the same job for the
              horizontal seam between wrapped rows. */}
          <div style={{ padding: '10px 13px', boxShadow: `1px 0 0 ${c.borderSubtle}, 0 1px 0 ${c.borderSubtle}`, cursor: 'help' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
              <t.icon size={11} color={t.accent} />
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: c.textMuted }}>{t.label}</span>
              <Info size={10} color={c.textMuted} style={{ marginLeft: 'auto', opacity: 0.6 }} />
            </div>
            <div style={{ fontSize: 20, fontWeight: 900, color: t.accent, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{t.value}</div>
            <div style={{ fontSize: 11, color: c.textSecondary, marginTop: 3, lineHeight: 1.3 }}>{t.sub}</div>
          </div>
        </MetricTip>
      ))}
    </div>
  )
}

// ─── Planner worklist (Learn plane) ─────────────────────────────────────────
// One action queue, tabbed by the ACTION a planner takes (raise a new PO,
// expedite an existing one, transfer, reduce excess, de-risk a supplier). Every
// row states the item, a brief of the issue and the recommended fix, and its
// button carries out that exact fix — with the result shown as an in-place
// notification rather than a jarring scroll.

// Each tab/family owns a colour, an icon and the sub-label its £ figure means.
const FAMILY_META: Record<string, { label: string; color: string; icon: React.ElementType; impact: string }> = {
  raise_po: { label: 'Raise PO',      color: 'var(--status-info-text)', icon: PackagePlus,    impact: 'at risk' },
  expedite: { label: 'Expedite',      color: '#EA580C', icon: Zap,            impact: 'at risk' },
  transfer: { label: 'Transfer',      color: '#7C3AED', icon: ArrowLeftRight, impact: 'at risk' },
  reduce:   { label: 'Reduce excess', color: 'var(--status-warning-text)', icon: Recycle,        impact: 'tied up' },
  derisk:   { label: 'De-risk',       color: '#0891B2', icon: ShieldAlert,    impact: 'exposed' },
}
// Per-kind badge label + the verb on its action button. The badge says what the
// work IS; the button says what pressing it DOES — and it must match the row's
// recommended action. Excess is special: the verb is the row's own disposition
// (return to vendor / mark down / …), so the button always names the exact fix.
const KIND_META: Record<string, { label: string; act: string }> = {
  purchase:  { label: 'Raise PO',  act: 'Raise PO →' },
  expedite:  { label: 'Expedite',  act: 'Expedite →' },
  transfer:  { label: 'Transfer',  act: 'Transfer →' },
  rebalance: { label: 'Rebalance', act: 'Rebalance →' },
  stockout:  { label: 'Stockout',  act: 'Raise PO →' },
  low_stock: { label: 'Low stock', act: 'Raise PO →' },
  excess:    { label: 'Excess',    act: 'Dispose →' },
  supplier:  { label: 'Supplier',  act: 'Review →' },
}
const DISP_VERB: Record<string, string> = {
  rebalance: 'Rebalance', return_to_vendor: 'Return to vendor', markdown: 'Mark down', write_off: 'Write off',
}
// The button label — verb-matched to the recommended action on that row.
function actLabel(it: any): string {
  if (it.kind === 'excess') return `${DISP_VERB[it.disposition] ?? 'Dispose'} →`
  return KIND_META[it.kind]?.act ?? 'Action →'
}
const PRIO_COLOR: Record<string, string> = { critical: '#DC2626', high: '#D97706', medium: '#2563EB', low: '#64748B' }

export interface WorklistNotice { tone: 'success' | 'info' | 'error'; text: string }

export function PlannerWorklist({ onAct, scope = {}, canAct = true, notice, onDismissNotice }: {
  onAct?: (item: any) => void
  scope?: DemandScope
  canAct?: boolean
  notice?: WorklistNotice | null
  onDismissNotice?: () => void
}) {
  const { c } = useTheme()
  const [page, setPage] = useState(1)
  const [family, setFamily] = useState('all')
  const [sort, setSort] = useState('priority')
  const PER = 10
  useEffect(() => { setPage(1) }, [scope.segment, scope.sku_category, scope.warehouse_code, family, sort])
  const { data, isFetching } = useQuery({
    queryKey: ['planner-worklist', scope, page, family, sort],
    queryFn: () => fetchPlannerWorklist(scope, page, PER, { family: family === 'all' ? undefined : family, sort }),
    refetchInterval: 30_000, placeholderData: (prev) => prev,
  })
  const items = data?.items ?? []
  const families = (data?.families ?? []) as any[]
  const totalCount = families.reduce((s, f) => s + f.count, 0)

  // If the active tab empties out (e.g. its last item was actioned), fall back to All.
  useEffect(() => {
    if (family !== 'all' && families.length && !families.some(f => f.key === family)) setFamily('all')
  }, [families, family])

  // Tabs: All + one per action family, each carrying its full-queue count and a
  // critical badge — the primary way to triage "what kind of action is needed".
  const segments = [
    { key: 'all', label: 'All', count: totalCount, critical: data?.critical ?? 0, color: c.textSecondary, hint: 'Every open action across all families' },
    ...families.map(f => ({ key: f.key, label: f.label, count: f.count, critical: f.critical, color: FAMILY_META[f.key]?.color ?? c.textSecondary, hint: f.hint })),
  ]

  const NOTICE_STYLE: Record<string, { bg: string; border: string; text: string; Icon: React.ElementType }> = {
    success: { bg: c.success.bg, border: c.success.border, text: c.success.text, Icon: CheckCircle2 },
    info:    { bg: c.info.bg, border: c.info.border, text: c.info.text, Icon: Info },
    error:   { bg: c.danger.bg, border: c.danger.border, text: c.danger.text, Icon: AlertTriangle },
  }

  return (
    <div className="card">
      <div className="card-header">
        <div style={{ minWidth: 0 }}>
          <CardTitle tip="Planner Worklist" icon={ClipboardCheck} color="#B45309">Planner Worklist</CardTitle>
          <div className="card-subtitle">One action queue — for every open position it states the issue, the recommended fix and who owns it, and the button carries out that exact fix · tabbed by the action needed, ranked by capital at risk</div>
        </div>
      </div>

      {/* In-place notification — the result of the last action, shown here rather
          than scrolling the page to a far-off card */}
      {notice && (() => {
        const ns = NOTICE_STYLE[notice.tone] ?? NOTICE_STYLE.info
        return (
          <div style={{ margin: '10px 16px 0', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: ns.bg, border: `1px solid ${ns.border}` }}>
            <ns.Icon size={15} color={ns.text} style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: ns.text, flex: 1 }}>{notice.text}</span>
            {onDismissNotice && (
              <button onClick={onDismissNotice} title="Dismiss" style={{ display: 'flex', background: 'none', border: 'none', cursor: 'pointer', color: ns.text, opacity: 0.7, padding: 2 }}>
                <X size={13} />
              </button>
            )}
          </div>
        )
      })()}

      {/* Action tabs — counts span the whole queue */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', padding: '10px 16px 4px' }}>
        {segments.map(seg => {
          const active = family === seg.key
          const Icon = seg.key === 'all' ? undefined : FAMILY_META[seg.key]?.icon
          const disabled = seg.count === 0 && seg.key !== 'all'
          return (
            <button key={seg.key} onClick={() => setFamily(seg.key)} title={seg.hint} disabled={disabled}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 8, cursor: disabled ? 'default' : 'pointer',
                background: active ? `${seg.color}14` : c.surface, border: `1.5px solid ${active ? seg.color : c.border}`,
                color: active ? seg.color : c.textSecondary, opacity: disabled ? 0.45 : 1,
              }}>
              {Icon && <Icon size={13} color={active ? seg.color : c.textMuted} strokeWidth={2.2} />}
              <span style={{ fontSize: 11.5, fontWeight: 800 }}>{seg.label}</span>
              <span style={{ fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums', padding: '0 6px', borderRadius: 10, background: active ? `${seg.color}22` : c.surfaceSubtle, color: active ? seg.color : c.textMuted }}>
                {seg.count.toLocaleString()}
              </span>
              {seg.critical > 0 && (
                <span title={`${seg.critical} critical`} style={{ fontSize: 11, fontWeight: 900, color: '#fff', background: '#DC2626', borderRadius: 10, padding: '1px 5px', fontVariantNumeric: 'tabular-nums' }}>
                  {seg.critical}!
                </span>
              )}
            </button>
          )
        })}
        <div style={{ flex: 1 }} />
        <MiniSelect value={sort} onChange={setSort} active={sort !== 'priority'} title="Sort the queue"
          options={[{ value: 'priority', label: 'By priority' }, { value: 'value', label: 'By £ impact' }, { value: 'benefit', label: 'By net £ benefit' }, { value: 'sla', label: 'By SLA' }, { value: 'sku', label: 'By SKU' }]} />
      </div>

      <div style={{ overflowX: 'auto' }}>
        {/* table-layout: fixed makes the header widths authoritative — without it
            the browser re-derives each column's width from its widest cell, so
            long owner names or disposition verbs silently override the intended
            widths and the columns drift out of alignment with the header. */}
        <table className="data-table" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 62 }} />
            <col style={{ width: '32%' }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: 84 }} />
            <col style={{ width: 108 }} />
            <col style={{ width: 116 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Priority</th>
              <th>Issue</th>
              <th>Recommended action</th>
              <th style={{ textAlign: 'right' }}><HelpTip tip="Value at Risk (item)">£ impact</HelpTip></th>
              <th>Owner · <HelpTip tip="SLA">SLA</HelpTip></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', fontSize: 11, color: c.textMuted, padding: '18px 0' }}>
                {family === 'all' ? 'Worklist clear — every position is inside its policy window.'
                  : `No ${FAMILY_META[family]?.label.toLowerCase() ?? ''} actions outstanding.`}
              </td></tr>
            )}
            {items.map((it: any) => {
              const fam = FAMILY_META[it.family] ?? FAMILY_META.raise_po
              const km = KIND_META[it.kind] ?? { label: it.kind, act: 'Action →' }
              const slaTxt = it.sla_hours <= 24 ? `${it.sla_hours}h` : `${Math.round(it.sla_hours / 24)}d`
              const slaColor = it.sla_hours <= 8 ? '#DC2626' : it.sla_hours <= 24 ? '#D97706' : c.textMuted
              return (
                <tr key={it.id} style={{ borderLeft: `3px solid ${PRIO_COLOR[it.priority_label] || '#64748B'}` }}>
                  {/* PRIORITY */}
                  <td style={{ verticalAlign: 'top' }}>
                    <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '2px 7px', borderRadius: 20, background: `${PRIO_COLOR[it.priority_label]}18`, color: PRIO_COLOR[it.priority_label], border: `1px solid ${PRIO_COLOR[it.priority_label]}44`, whiteSpace: 'nowrap' }}>
                      {it.priority_label}
                    </span>
                  </td>
                  {/* ISSUE — type badge + item, then a one-line brief of what's wrong */}
                  <td style={{ verticalAlign: 'top', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <span style={{ fontSize: 11, fontWeight: 800, padding: '1px 6px', borderRadius: 20, whiteSpace: 'nowrap', background: `${fam.color}14`, color: fam.color, border: `1px solid ${fam.color}40`, flexShrink: 0 }}>
                        {km.label}
                      </span>
                      <span title={it.description} style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                        {it.description}
                      </span>
                    </div>
                    <div title={it.issue} style={{ marginTop: 2, fontSize: 11, color: c.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{it.sku_code}</span>
                      {it.issue ? <> · {it.issue}</> : null}
                    </div>
                  </td>
                  {/* RECOMMENDED ACTION — the fix the button carries out */}
                  <td style={{ verticalAlign: 'top', overflow: 'hidden' }}>
                    <div title={it.recommended_action} style={{ display: 'flex', alignItems: 'flex-start', gap: 5, lineHeight: 1.35 }}>
                      <ArrowRight size={12} color={fam.color} style={{ marginTop: 2, flexShrink: 0 }} />
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: c.textPrimary, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{it.recommended_action}</span>
                    </div>
                    {it.net_benefit_gbp != null && it.net_benefit_gbp !== 0 && (
                      <div style={{ fontSize: 11, fontWeight: 700, color: it.net_benefit_gbp > 0 ? '#059669' : '#DC2626', marginLeft: 17, marginTop: 1 }}>
                        net {it.net_benefit_gbp > 0 ? '+' : ''}{fmtGBP(it.net_benefit_gbp)} benefit
                      </div>
                    )}
                  </td>
                  {/* £ IMPACT */}
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', verticalAlign: 'top' }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: it.value_at_risk_gbp > 0 ? c.textPrimary : c.textMuted }}>
                      {it.value_at_risk_gbp > 0 ? fmtGBP(it.value_at_risk_gbp) : '—'}
                    </div>
                    {it.value_at_risk_gbp > 0 && <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: c.textMuted }}>{fam.impact}</div>}
                  </td>
                  {/* OWNER · SLA */}
                  <td style={{ verticalAlign: 'top', overflow: 'hidden' }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: slaColor, background: `${slaColor}14`, borderRadius: 20, padding: '1px 7px', whiteSpace: 'nowrap' }}>{slaTxt}</span>
                    <div title={it.owner} style={{ fontSize: 11, color: c.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.owner}</div>
                  </td>
                  {/* ACTION */}
                  <td style={{ verticalAlign: 'top' }}>
                    {onAct && canAct && (
                      <button onClick={() => onAct(it)} title={it.recommended_action}
                        style={{ width: '100%', fontSize: 11, fontWeight: 800, padding: '4px 8px', borderRadius: 6, cursor: 'pointer', background: fam.color, color: '#fff', border: `1px solid ${fam.color}`, lineHeight: 1.25 }}>
                        {actLabel(it)}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <TablePager page={data?.page ?? 1} pages={data?.pages ?? 1} total={data?.total ?? 0}
        perPage={PER} onPage={setPage} label="actions" busy={isFetching} />
    </div>
  )
}

// ─── Forecast decomposition waterfall (Sense — SKU drill-in) ─────────────────

export function ForecastWaterfall({ forecast }: { forecast: any }) {
  const { c } = useTheme()
  const decomp = forecast?.decomposition ?? []
  if (!decomp.length) return null
  const total = forecast.forecasted_qty || 1
  const maxAbs = Math.max(...decomp.map((d: any) => Math.abs(d.units)), total)

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--status-info-text)', marginBottom: 2 }}>
        <HelpTip tip="Demand Model">Why this forecast — driver decomposition</HelpTip>
      </div>
      <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 7 }}>
        {forecast.horizon_days}-day forecast of <b>{total.toLocaleString()}</b> units, built from a base rate then
        shaped by seasonality, weather and IoT. Every unit traces to a driver.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {decomp.map((d: any) => {
          const pos = d.units >= 0
          const w = (Math.abs(d.units) / maxAbs) * 100
          const col = DRIVER_COLOR[d.group] || '#64748B'
          return (
            <div key={d.driver} className="meter-row">
              <span style={{ fontSize: 11, color: c.textSecondary, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: col, flexShrink: 0 }} />
                {d.label}
              </span>
              <div style={{ position: 'relative', height: 14, background: c.surfaceSubtle, borderRadius: 4, overflow: 'hidden' }}>
                <div style={{
                  position: 'absolute', left: d.group === 'base' ? 0 : '50%', height: '100%',
                  width: d.group === 'base' ? '100%' : `${w / 2}%`,
                  transform: !pos && d.group !== 'base' ? 'translateX(-100%)' : undefined,
                  background: col, opacity: d.group === 'base' ? 0.55 : 0.85, borderRadius: 3,
                }} />
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: pos ? c.textPrimary : '#DC2626' }}>
                {pos ? '+' : ''}{d.units.toLocaleString()}
              </span>
            </div>
          )
        })}
        <div className="meter-row" style={{ borderTop: `1px solid ${c.border}`, paddingTop: 5, marginTop: 1 }}>
          <span style={{ fontSize: 11.5, fontWeight: 800, color: c.textPrimary }}>Forecast total</span>
          <span style={{ fontSize: 11, color: c.textMuted }}>
            <HelpTip tip="MAPE">MAPE {forecast.mape_pct}%</HelpTip> · band {forecast.confidence_lower_qty?.toLocaleString()}–{forecast.confidence_upper_qty?.toLocaleString()}
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 900, textAlign: 'right', color: 'var(--status-info-text)', fontVariantNumeric: 'tabular-nums' }}>{total.toLocaleString()}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Statistical safety-stock explainer (Position — SKU drill-in) ────────────

export function SafetyStockExplainer({ item }: { item: any }) {
  const { c } = useTheme()
  if (item?.safety_stock_z == null) return null
  const stat = item.safety_stock_level ?? 0
  const staticSS = item.safety_stock_static ?? stat
  const delta = stat - staticSS
  const rows = [
    { k: 'Service target', tip: 'Service Level Target', v: `${item.service_level_target_pct}% → z = ${item.safety_stock_z}`, hint: `segment ${item.segment}` },
    { k: 'Demand variability', tip: '', v: `σ ${item.sigma_daily}/day (CV ${item.demand_cv})`, hint: 'daily demand noise' },
    { k: 'Lead-time variability', tip: '', v: `σ ${item.sigma_lead_days}d (CV ${item.lead_time_cv})`, hint: `${item.primary_supplier} reliability` },
    { k: 'Protection interval', tip: '', v: `${item.protection_days} days`, hint: 'lead time + review' },
  ]
  return (
    <div style={{ marginTop: 10, paddingTop: 9, borderTop: `1px solid ${c.borderSubtle}` }}>
      <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--status-info-text)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Sparkles size={12} />
        <HelpTip tip="Statistical Safety Stock">Statistical safety stock — z × √( protection·σ²demand + demand²·σ²lead )</HelpTip>
      </div>
      <div className="split-aside" style={{ '--aside-w': '210px', '--split-gap': '16px', alignItems: 'center' } as React.CSSProperties}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {rows.map(r => (
            <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, padding: '3px 0', borderBottom: `1px solid ${c.borderSubtle}` }}>
              <span style={{ color: c.textSecondary }}>
                {r.tip ? <HelpTip tip={r.tip}>{r.k}</HelpTip> : r.k}
                <span style={{ color: c.textMuted, fontSize: 11 }}> · {r.hint}</span>
              </span>
              <span style={{ fontWeight: 700, color: c.textPrimary, fontVariantNumeric: 'tabular-nums' }}>{r.v}</span>
            </div>
          ))}
        </div>
        <div style={{ borderRadius: 8, padding: '10px 12px', background: c.info.bg, border: `1px solid ${c.info.border}`, textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: c.info.text, marginBottom: 2 }}>STATISTICAL SAFETY STOCK</div>
          <div style={{ fontSize: 24, fontWeight: 900, color: c.info.text, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{stat.toLocaleString()}</div>
          <div style={{ fontSize: 11, color: c.textSecondary, marginTop: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            {delta === 0 ? 'matches the old constant' : (
              <>
                {delta < 0 ? <TrendingDown size={11} color="#059669" /> : <TrendingUp size={11} color="#DC2626" />}
                was {staticSS.toLocaleString()} · {delta > 0 ? '+' : ''}{delta.toLocaleString()}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Demand drivers — aggregate sensing view (Sense) ─────────────────────────

// ─── Programme & policy drivers (Orchestrate) ───────────────────────────────
// These move the medium-term install/service PROGRAMME, not next week's parts
// consumption — so they belong beside S&OP, not in short-horizon demand sensing.

export function ProgrammePolicyDrivers({ signals }: { signals?: any }) {
  const { c } = useTheme()
  if (!signals) return <PanelSkeleton title="Programme & Policy Drivers" />
  const sb = signals.service_book || {}
  const ps = signals.policy_signals || {}
  const cpq = signals.cpq_pipeline || {}
  const mh = signals.mhhs_schedule || {}

  const blocks = [
    {
      title: 'HomeCare service book', icon: ClipboardList, color: 'var(--status-warning-text)',
      headline: (sb.annual_services_due_30d ?? 0).toLocaleString(),
      caption: 'annual services due (30d)',
      rows: [
        ['Breakdown callouts (24h)', (sb.breakdown_callouts_24h ?? 0).toLocaleString()],
        ['Contracts active', (sb.homecare_contracts_active ?? 0).toLocaleString()],
        ['Season', String(sb.season || '').replace(/_/g, ' ')],
        ['Switch-on surge', sb.boiler_switch_on_surge_risk ? 'Sep–Oct risk' : 'Low'],
      ],
    },
    {
      title: 'Grants & install pipeline', icon: TrendingUp, color: '#059669',
      headline: (ps.bus_grant_applications_30d ?? 0).toLocaleString(),
      caption: 'Boiler Upgrade Scheme apps (30d)',
      rows: [
        ['Heat-pump BOMs active', (cpq.heat_pump_boms_active ?? 0).toLocaleString()],
        ['EV-charger BOMs active', (cpq.ev_charger_boms_active ?? 0).toLocaleString()],
        ['ECO4 referrals (30d)', (ps.eco4_referrals_30d ?? 0).toLocaleString()],
        ['Ofgem price cap change', ps.price_cap_next_change ?? '—'],
      ],
    },
    {
      title: 'MHHS smart-meter rollout', icon: Gauge, color: '#2563EB',
      headline: (mh.install_rate_per_week ?? 0).toLocaleString(),
      caption: 'installs per week',
      rows: [
        ['Installed YTD', (mh.installed_ytd ?? 0).toLocaleString()],
        ['Q3 target', (mh.smart_meters_target_q3 ?? 0).toLocaleString()],
        ['Smart-meter BOMs', (cpq.smart_meter_boms_active ?? 0).toLocaleString()],
        ['Booking uplift', ps.smart_meter_booking_uplift_pct != null ? `${ps.smart_meter_booking_uplift_pct}%` : '—'],
      ],
    },
  ]

  return (
    <div className="card section-gap">
      <div className="card-header">
        <div style={{ minWidth: 0 }}>
          <CardTitle tip="S&OP" icon={CalendarRange} color="#7C3AED">Programme &amp; Policy Drivers</CardTitle>
          <div className="card-subtitle">
            Grants, the service book and the rollout programme set medium-term install volume — they feed S&amp;OP, not next week's parts consumption
          </div>
        </div>
      </div>
      <div className="auto-grid card-body" style={{ '--cols': '3', '--col-min': '160px', '--grid-gap': '10px', padding: '12px 14px' } as React.CSSProperties}>
        {blocks.map(b => (
          <div key={b.title} style={{ border: `1px solid ${c.border}`, borderLeft: `3px solid ${b.color}`, borderRadius: 8, padding: '10px 12px', background: c.surface }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: b.color, marginBottom: 7, display: 'flex', alignItems: 'center', gap: 5 }}>
              <b.icon size={12} /> {b.title}
            </div>
            <div style={{ fontSize: 24, fontWeight: 900, color: c.textPrimary, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{b.headline}</div>
            <div style={{ fontSize: 11, color: c.textMuted, marginTop: 2, marginBottom: 8 }}>{b.caption}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {b.rows.map(([k, v]) => (
                <div key={k as string} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
                  <span style={{ color: c.textSecondary }}>{k}</span>
                  <span style={{ color: c.textPrimary, fontWeight: 700, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── MEIO — risk pooling (Position) ─────────────────────────────────────────

export function MeioCard({ scope = {} }: { scope?: DemandScope }) {
  const { c } = useTheme()
  const [page, setPage] = useState(1)
  const PER = 8
  useEffect(() => { setPage(1) }, [scope.segment, scope.sku_category, scope.warehouse_code])
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['demand-meio', scope, page], queryFn: () => fetchMeio(scope, page, PER),
    refetchInterval: 60_000, placeholderData: (prev) => prev,
  })
  if (isError) return <PanelError title="Multi-Echelon Optimisation" onRetry={() => refetch()} />
  if (isLoading || !data) return <PanelSkeleton title="Multi-Echelon Optimisation" />

  const chart = (data.rows || []).map((r: any) => ({
    sku: r.sku_code.replace('SKU-', ''),
    decentralised: r.decentralised_units,
    pooled: r.pooled_units,
    saving: r.saving_gbp,
  }))

  return (
    <div className="card">
      <div className="card-header">
        <div style={{ minWidth: 0 }}>
          <CardTitle tip="Multi-Echelon Optimisation" icon={Network} color="#0891B2">Multi-Echelon Optimisation</CardTitle>
          <div className="card-subtitle">Echelon sizing (in force) vs single-echelon sizing — the duplicated buffer it removes</div>
        </div>
        <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 20, background: '#ECFEFF', color: 'var(--status-info-text)', border: '1px solid #A5F3FC' }}>
          {data.pooling_benefit_pct}% leaner
        </span>
      </div>
      <div className="card-body" style={{ padding: '12px 14px' }}>
        <div className="auto-grid" style={{ '--cols': '3', '--col-min': '118px', '--grid-gap': '7px', marginBottom: 10 } as React.CSSProperties}>
          {[
            { l: 'Single-echelon', tip: 'Single-Echelon Sizing', v: fmtGBP(data.single_echelon_capital_gbp ?? data.decentralised_capital_gbp), s: 'each site sized alone', col: c.textMuted },
            { l: 'Echelon (in force)', tip: 'Echelon Stock', v: fmtGBP(data.echelon_capital_gbp ?? data.pooled_capital_gbp), s: 'counts downstream stock', col: '#0891B2' },
            { l: 'Duplication removed', tip: 'Capital Released', v: fmtGBP(data.capital_released_gbp), s: 'buffer counted twice', col: '#059669' },
          ].map(x => (
            <MetricTip key={x.l} label={x.tip} block>
              <div style={{ background: c.surfaceSubtle, borderRadius: 7, padding: '7px 9px', border: `1px solid ${c.borderSubtle}`, cursor: 'help' }}>
                <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 2 }}>{x.l}</div>
                <div style={{ fontSize: 16, fontWeight: 900, color: x.col, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{x.v}</div>
                <div style={{ fontSize: 11, color: c.textMuted, marginTop: 2 }}>{x.s}</div>
              </div>
            </MetricTip>
          ))}
        </div>

        {/* Per-SKU buffer comparison */}
        <div style={{ fontSize: 11, color: c.textMuted, marginBottom: 4 }}>
          Safety-stock units per SKU — single-echelon vs echelon sizing (largest duplication)
        </div>
        <ResponsiveContainer width="100%" height={135}>
          <ComposedChart data={chart} margin={{ top: 2, right: 6, left: 0, bottom: 0 }} barGap={2}>
            <CartesianGrid strokeDasharray="3 3" stroke={c.borderSubtle} vertical={false} />
            <XAxis dataKey="sku" tick={{ fontSize: 11 }} interval={0} />
            <YAxis tick={{ fontSize: 11 }} width={38} />
            <Tooltip
              contentStyle={chartTooltipStyle(c)}
              formatter={(v: any, n: string) => [Number(v).toLocaleString() + ' units', n === 'decentralised' ? 'Single-echelon' : 'Echelon (in force)']}
            />
            <Bar dataKey="decentralised" fill="#94A3B8" radius={[2, 2, 0, 0]} barSize={11} />
            <Bar dataKey="pooled" fill="#0891B2" radius={[2, 2, 0, 0]} barSize={11} />
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', gap: 14, fontSize: 11, color: c.textSecondary, marginTop: 2, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: '#94A3B8' }} />Single-echelon</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: '#0891B2' }} />Echelon (in force)</span>
        </div>
        {data.why_relevant && (
          <div style={{ marginTop: 7, fontSize: 11, color: c.textSecondary, background: c.surfaceSubtle, border: `1px solid ${c.borderSubtle}`, borderRadius: 6, padding: '6px 9px', lineHeight: 1.45 }}>
            <b>Why MEIO applies here: </b>{data.why_relevant}
          </div>
        )}
      </div>
      <TablePager page={data.page ?? 1} pages={data.pages ?? 1} total={data.total ?? 0}
        perPage={PER} onPage={setPage} label="SKUs" busy={isFetching} />
    </div>
  )
}

// ─── Replenishment routing — which document fills which echelon (Execute) ────

export function ReplenishmentRoutingCard() {
  const { c } = useTheme()
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['replenishment-routing'], queryFn: fetchReplenishmentRouting, refetchInterval: 60_000 })
  if (isError) return <PanelError title="Replenishment Routing — PO vs STO" onRetry={() => refetch()} section />
  if (isLoading || !data) return <PanelSkeleton title="Replenishment Routing — PO vs STO" section />
  const ROLE_COLOR: Record<string, string> = { ndc: '#2563EB', hub: '#7C3AED' }

  return (
    <div className="card section-gap">
      <div className="card-header">
        <div style={{ minWidth: 0 }}>
          <CardTitle tip="Goods Receipt" icon={Route} color="#4F46E5">Replenishment Routing — PO vs STO</CardTitle>
          <div className="card-subtitle">A shortfall is filled differently depending on which echelon it sits at</div>
        </div>
      </div>
      <div className="card-body" style={{ padding: '12px 14px' }}>
        <div className="auto-grid" style={{ '--cols': '2', '--col-min': '170px', '--grid-gap': '10px', marginBottom: 12 } as React.CSSProperties}>
          {(data.rules || []).map((r: any) => {
            const col = ROLE_COLOR[r.role] || '#2563EB'
            return (
              <div key={r.role} style={{ border: `1px solid ${c.border}`, borderLeft: `3px solid ${col}`, borderRadius: 8, padding: '10px 12px', background: c.surface }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: c.textPrimary }}>{r.echelon}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: r.positions_short > 0 ? '#DC2626' : '#059669' }}>
                    {r.positions_short} short
                  </span>
                </div>
                <div style={{ fontSize: 11, color: c.textMuted, fontFamily: 'monospace', marginTop: 1 }}>{r.site}</div>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {[
                    ['Filled by', r.shortfall_filled_by],
                    ['Raised by', r.raised_by],
                    ['Supplied by', r.supplied_by],
                    ['Document', r.doc_type],
                    ['Lead time', r.typical_lead],
                  ].map(([k, v]) => (
                    <div key={k as string} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
                      <span style={{ color: c.textMuted, flexShrink: 0 }}>{k}</span>
                      <span style={{ color: c.textPrimary, fontWeight: 600, textAlign: 'right' }}>{v as string}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 8, paddingTop: 7, borderTop: `1px solid ${c.borderSubtle}`, fontSize: 11, color: c.textSecondary, lineHeight: 1.45 }}>
                  {r.why}
                </div>
                <div style={{ marginTop: 6, fontSize: 11, fontWeight: 700, color: col }}>
                  {r.open_docs} open {r.role === 'ndc' ? 'PO' : 'STO'}{r.open_docs !== 1 ? 's' : ''}
                </div>
              </div>
            )
          })}
        </div>

        {/* STO lifecycle */}
        <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: c.textMuted, marginBottom: 6 }}>
          STO lifecycle — the hub owns the document end to end
        </div>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, flexWrap: 'wrap' }}>
          {(data.flow || []).map((f: any, i: number) => (
            <React.Fragment key={f.step}>
              <div style={{ flex: '1 1 150px', background: c.surfaceSubtle, border: `1px solid ${c.borderSubtle}`, borderRadius: 7, padding: '7px 10px' }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#4F46E5', fontFamily: 'monospace' }}>STEP {f.step}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: c.textPrimary, marginTop: 1 }}>{f.actor}</div>
                <div style={{ fontSize: 11, color: c.textSecondary, marginTop: 2, lineHeight: 1.4 }}>{f.action}</div>
              </div>
              {i < (data.flow || []).length - 1 && (
                <div style={{ display: 'flex', alignItems: 'center', padding: '0 4px', color: c.textMuted }}>›</div>
              )}
            </React.Fragment>
          ))}
        </div>
        <div style={{ marginTop: 9, fontSize: 11, color: c.textSecondary, background: c.info.bg, border: `1px solid ${c.info.border}`, borderRadius: 6, padding: '7px 10px', lineHeight: 1.45 }}>
          <b>Escalation:</b> {data.escalation}
        </div>
      </div>
    </div>
  )
}

// ─── S&OP + constrained allocation (Orchestrate) ────────────────────────────

const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function SopAllocationCard() {
  const refData = useReferenceData()
  const { c } = useTheme()
  const [cat, setCat] = useState('heat_pump')
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['sop-plan'], queryFn: () => fetchSopPlan(6), refetchInterval: 120_000 })
  if (isError) return <PanelError title="S&OP — Demand vs Supply" onRetry={() => refetch()} />
  if (isLoading || !data) return <PanelSkeleton title="S&OP — Demand vs Supply" />
  const alloc = data.heat_pump_allocation
  const row = (data.categories || []).find((x: any) => x.category === cat)
  const chart = (row?.periods || []).map((p: any) => ({
    month: MONTH_ABBR[p.month],
    demand: p.demand_units,
    supply: p.supply_units,
    gap: p.gap_units,
    constrained: p.constrained,
  }))

  return (
    <div className="card">
      <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <CardTitle tip="S&OP" icon={CalendarRange} color="#7C3AED">S&amp;OP — Demand vs Supply</CardTitle>
          <div className="card-subtitle">{data.horizon_months}-month reconciliation · red months are supply-constrained</div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {(data.categories || []).map((x: any) => (
            <button key={x.category} onClick={() => setCat(x.category)}
              style={{
                fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20, cursor: 'pointer',
                background: cat === x.category ? '#7C3AED' : c.surface,
                color: cat === x.category ? '#fff' : c.textSecondary,
                border: `1px solid ${cat === x.category ? '#7C3AED' : c.border}`,
              }}>
              {refData.catLabels[x.category] || x.category}
            </button>
          ))}
        </div>
      </div>
      <div className="card-body" style={{ padding: '10px 14px' }}>
        <ResponsiveContainer width="100%" height={150}>
          <ComposedChart data={chart} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={c.borderSubtle} vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={44} />
            <Tooltip contentStyle={chartTooltipStyle(c)}
              formatter={(v: any, n: string) => [Number(v).toLocaleString() + ' units', n === 'demand' ? 'Demand' : 'Supply capability']} />
            <Bar dataKey="demand" radius={[2, 2, 0, 0]} barSize={18}>
              {chart.map((e: any, i: number) => (
                <Cell key={i} fill={e.constrained ? '#DC2626' : '#A78BFA'} />
              ))}
            </Bar>
            <Line type="monotone" dataKey="supply" stroke="#7C3AED" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', gap: 14, fontSize: 11, color: c.textSecondary, marginTop: 2, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: '#A78BFA' }} />Demand (covered)</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: '#DC2626' }} />Demand (constrained)</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 14, height: 2, background: '#7C3AED' }} />Supply capability</span>
        </div>

        {alloc && (
          <div style={{ borderRadius: 8, border: `1px solid ${alloc.constrained ? c.danger.border : c.borderSubtle}`, background: alloc.constrained ? c.danger.bg : c.surfaceSubtle, padding: '9px 11px' }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: alloc.constrained ? c.danger.text : c.textSecondary, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Layers3 size={12} />
              <HelpTip tip="Constrained Allocation">
                Heat-pump allocation — supply {alloc.supply_units.toLocaleString()} vs demand {alloc.demand_units.toLocaleString()}{alloc.constrained ? ' · CONSTRAINED' : ''}
              </HelpTip>
            </div>
            <div className="auto-grid" style={{ '--cols': '4', '--col-min': '96px', '--grid-gap': '6px' } as React.CSSProperties}>
              {alloc.by_site.map((s: any) => {
                const pct = s.requested ? (s.allocated / s.requested) * 100 : 100
                return (
                  <div key={s.site} title={`${s.site_name}: allocated ${s.allocated} of ${s.requested} requested`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: c.textMuted }}>
                      <span>{refData.siteShort[s.site] || s.site}</span>
                      <span style={{ fontWeight: 700, color: s.shortfall > 0 ? '#DC2626' : '#059669' }}>{s.allocated.toLocaleString()}</span>
                    </div>
                    <div style={{ height: 5, background: c.surfaceMuted, borderRadius: 3, overflow: 'hidden', marginTop: 3 }}>
                      <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: s.shortfall > 0 ? '#DC2626' : '#10B981' }} />
                    </div>
                    <div style={{ fontSize: 11, color: c.textMuted, marginTop: 2 }}>
                      of {s.requested.toLocaleString()}{s.shortfall > 0 ? ` · −${s.shortfall}` : ''}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Network scenario twin (Orchestrate) ────────────────────────────────────

export function ScenarioTwinCard() {
  const refData = useReferenceData()
  const { c } = useTheme()
  const [shock, setShock] = useState(30)
  const [slip, setSlip] = useState(4)
  const [cat, setCat] = useState<string>('all')
  const { data, isFetching } = useQuery({
    queryKey: ['sim-network', shock, slip, cat],
    queryFn: () => simulateNetwork({ demand_shock_pct: shock, lead_slip_days: slip, category: cat === 'all' ? null : cat }),
    placeholderData: (prev) => prev,
  })

  const shortChart = useMemo(
    () => (data?.skus ?? []).filter((s: any) => s.units_short > 0).slice(0, 6)
      .map((s: any) => ({ sku: s.sku_code.replace('SKU-', ''), short: s.units_short })),
    [data])

  return (
    <div className="card">
      <div className="card-header">
        <div style={{ minWidth: 0 }}>
          <CardTitle tip="Network Scenario Twin" icon={FlaskConical} color="#7C3AED">Network Scenario Twin</CardTitle>
          <div className="card-subtitle">Rehearse a shock across the whole network — who breaks, and what recovery costs</div>
        </div>
        {isFetching && <span style={{ fontSize: 11, color: c.textMuted }}>simulating…</span>}
      </div>
      <div className="card-body" style={{ padding: '10px 14px' }}>
        <div className="auto-grid" style={{ '--cols': '2', '--col-min': '190px', '--grid-gap': '14px', marginBottom: 9 } as React.CSSProperties}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, marginBottom: 2 }}>
              Demand shock: <span style={{ color: shock > 0 ? '#DC2626' : '#059669', fontWeight: 800 }}>{shock > 0 ? '+' : ''}{shock}%</span>
            </div>
            <input type="range" min={-20} max={80} step={5} value={shock} onChange={e => setShock(parseInt(e.target.value))} style={{ width: '100%' }} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, marginBottom: 2 }}>
              Supply slip: <span style={{ color: slip > 0 ? '#DC2626' : c.textPrimary, fontWeight: 800 }}>+{slip}d</span>
            </div>
            <input type="range" min={0} max={21} step={1} value={slip} onChange={e => setSlip(parseInt(e.target.value))} style={{ width: '100%' }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
          {['all', 'boiler', 'heat_pump', 'smart_meter', 'ev_charger'].map(k => (
            <button key={k} onClick={() => setCat(k)}
              style={{
                fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20, cursor: 'pointer',
                background: cat === k ? '#7C3AED' : c.surface, color: cat === k ? '#fff' : c.textSecondary,
                border: `1px solid ${cat === k ? '#7C3AED' : c.border}`,
              }}>
              {k === 'all' ? 'All SKUs' : refData.catLabels[k]}
            </button>
          ))}
        </div>

        <div className="auto-grid" style={{ '--cols': '3', '--col-min': '118px', '--grid-gap': '7px', marginBottom: 10 } as React.CSSProperties}>
          {[
            { l: 'SKUs tipping critical', tip: 'Newly Critical SKUs', v: `${data?.critical_before ?? 0} → ${data?.critical_after ?? 0}`, col: (data?.newly_critical ?? 0) > 0 ? '#DC2626' : '#059669', s: `${data?.newly_critical ?? 0} newly critical` },
            { l: 'Total units short', tip: 'Units Short', v: (data?.total_units_short ?? 0).toLocaleString(), col: (data?.total_units_short ?? 0) > 0 ? '#D97706' : '#059669', s: 'across the network' },
            { l: 'Expedite to recover', tip: 'Expedite Cost', v: fmtGBP(data?.expedite_cost_gbp ?? 0), col: (data?.expedite_cost_gbp ?? 0) > 0 ? '#DC2626' : '#059669', s: 'emergency freight' },
          ].map(x => (
            <MetricTip key={x.l} label={x.tip} block>
              <div style={{ background: c.surfaceSubtle, borderRadius: 7, padding: '8px 10px', border: `1px solid ${c.borderSubtle}`, cursor: 'help' }}>
                <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 3 }}>{x.l}</div>
                <div style={{ fontSize: 17, fontWeight: 900, color: x.col, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{x.v}</div>
                <div style={{ fontSize: 11, color: c.textMuted, marginTop: 2 }}>{x.s}</div>
              </div>
            </MetricTip>
          ))}
        </div>

        {shortChart.length > 0 ? (
          <>
            <div style={{ fontSize: 11, color: c.textMuted, marginBottom: 3 }}>Worst exposure under this scenario — units short</div>
            <ResponsiveContainer width="100%" height={110}>
              <ComposedChart data={shortChart} layout="vertical" margin={{ top: 2, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={c.borderSubtle} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="sku" tick={{ fontSize: 11 }} width={74} />
                <Tooltip contentStyle={chartTooltipStyle(c)} formatter={(v: any) => [Number(v).toLocaleString() + ' units', 'Short']} />
                <Bar dataKey="short" fill="#DC2626" radius={[0, 3, 3, 0]} barSize={11} />
              </ComposedChart>
            </ResponsiveContainer>
          </>
        ) : (
          <div style={{ fontSize: 11, color: c.success.text, background: c.success.bg, border: `1px solid ${c.success.border}`, borderRadius: 7, padding: '8px 11px' }}>
            The network absorbs this scenario — no SKU is pushed short.
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Inventory health, forecast quality & tuning feedback (Learn) ────────────

/**
 * The three tuning states. Colours are validated as a categorical set against
 * both the light (#FFFFFF) and dark (#111827) chart surfaces — lightness band,
 * chroma floor, deutan/tritan separation and contrast all pass in both modes,
 * so the same three hues serve either theme. Identity is never colour-alone:
 * every state also carries a legend label and a text nudge in the tooltip.
 *
 * Labels state the numeric threshold directly (bias < −3% / within ±3% /
 * bias > +3%) rather than leaving direction to be inferred from an axis
 * arrow — the axis just says "Forecast bias"; this is the one place that
 * spells out what each side and each colour means.
 */
const BIAS_STATES = {
  raise: { color: '#DC2626', label: 'Bias < −3% — under-forecasting, raise buffer' },
  hold:  { color: '#059669', label: 'Bias within ±3% — hold' },
  trim:  { color: '#8B5CF6', label: 'Bias > +3% — over-forecasting, trim buffer' },
} as const
type BiasState = keyof typeof BIAS_STATES

/** Derived from the number, not the server's wording, so the plot and the
 *  ±3% tolerance band can never disagree. */
function biasState(bias: number): BiasState {
  return bias > 3 ? 'trim' : bias < -3 ? 'raise' : 'hold'
}

/**
 * One card, not two. Working-capital health and the forecast-tuning loop stated
 * the same headline metrics (WMAPE, mean bias) when they sat side by side, so
 * the pair read as a duplicate — or a contradiction whenever one query lagged
 * the other. Merged, the portfolio figures are stated once at the top and the
 * per-SKU bias detail that explains them sits directly underneath.
 */
export function InventoryHealthCard({ summary, scopeLabel, scope = {} }: {
  summary: any; scopeLabel: string; scope?: DemandScope
}) {
  const { c } = useTheme()
  const navigate = useNavigate()
  // Plotted set = top 20% of the scope by impact (|bias| × stock value), not
  // raw value — a cheap SKU with wild bias outranks an expensive stable one,
  // so every bubble shown is actually worth tuning. Every bubble is clickable,
  // so nothing is reachable only through a direct label.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['forecast-tuning', scope, 'impact-plot'],
    queryFn: () => fetchForecastTuningImpact(scope, 20),
    refetchInterval: 120_000, placeholderData: (prev) => prev,
  })

  // Every figure is a server-side aggregate over the full filtered catalogue
  const stockValue = summary?.stock_value_gbp ?? 0
  const excessValue = summary?.excess_value_gbp ?? 0
  const valueAtRisk = summary?.value_at_risk_gbp ?? 0
  const wmape = summary?.wmape_pct ?? 0
  const meanBias = summary?.mean_bias_pct ?? 0

  const mix = [
    { label: 'Critical', count: summary?.critical ?? 0, color: '#EF4444' },
    { label: 'Low', count: summary?.low ?? 0, color: '#F59E0B' },
    { label: 'Healthy', count: summary?.healthy ?? 0, color: '#10B981' },
    { label: 'Excess', count: summary?.excess ?? 0, color: '#8B5CF6' },
  ]
  const skuCount = summary?.count ?? 0
  const total = skuCount || 1        // mix denominator — never divide by zero

  const points = (data?.rows || []).map((r: any) => ({
    sku: r.sku_code.replace('SKU-', ''),
    skuCode: r.sku_code,
    description: r.description,
    bias: r.bias_pct ?? 0,
    mape: r.mape_pct ?? 0,
    value: Math.max(r.stock_value_gbp ?? 0, 1),   // 0 would collapse the bubble
    nudge: r.policy_nudge,
    state: biasState(r.bias_pct ?? 0),
  }))
  const goToSku = (skuCode: string) => navigate(`/demand?sku=${encodeURIComponent(skuCode)}&tab=forecast`)
  // A diverging axis has to be centred on zero, or the tolerance band sits
  // off-centre and the eye reads a bias that isn't there.
  const biasMax = Math.max(6, ...points.map((p: any) => Math.abs(p.bias))) * 1.1
  const mapeMax = Math.max(10, ...points.map((p: any) => p.mape)) * 1.1
  // Pinned so the three series share one bubble scale — otherwise each would
  // size against its own slice and a "hold" SKU could out-size a critical one
  const valueMax = Math.max(1, ...points.map((p: any) => p.value))
  // Real (unclamped) £ bounds for the size-legend caption, so it states actual
  // numbers rather than a decorative small-to-large glyph
  const rawValues = (data?.rows || []).map((r: any) => r.stock_value_gbp ?? 0)
  const valueRange: [number, number] = rawValues.length
    ? [Math.min(...rawValues), Math.max(...rawValues)]
    : [0, 0]

  const tile = { background: c.surfaceSubtle, borderRadius: 8, padding: '9px 11px', border: `1px solid ${c.borderSubtle}` }

  return (
    <div className="card">
      <div className="card-header">
        <div style={{ minWidth: 0 }}>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Activity size={15} color="#059669" /> Inventory Health &amp; Forecast Quality
          </div>
          <div className="card-subtitle">
            Working capital, stock-health mix and the <HelpTip tip="Forecast Tuning">forecast tuning loop</HelpTip> {scopeLabel}
          </div>
        </div>
      </div>
      <div className="card-body">
        {/* Portfolio headline — value at stake and the forecast quality behind it */}
        <div className="auto-grid" style={{ '--cols': '99', '--col-min': '165px', '--grid-gap': '8px', marginBottom: 12 } as React.CSSProperties}>
          {[
            {
              label: <HelpTip tip="Working Capital">Stock value on hand</HelpTip>,
              value: fmtGBP(stockValue),
              icon: PoundSterling,
              color: '#2563EB',
              note: 'cash sitting on the shelf across this scope' as React.ReactNode,
            },
            {
              label: <HelpTip tip="Excess Capital">Excess capital tied up</HelpTip>,
              value: excessValue > 0 ? fmtGBP(excessValue) : '£0',
              icon: PackageX,
              color: excessValue > 0 ? '#8B5CF6' : '#059669',
              note: stockValue > 0
                ? `${((excessValue / stockValue) * 100).toFixed(1)}% of stock value · <5% best-in-class`
                : 'stock above the order-up-to target',
            },
            {
              label: <HelpTip tip="Value at Risk">Value at risk (critical)</HelpTip>,
              value: valueAtRisk > 0 ? fmtGBP(valueAtRisk) : '£0',
              icon: AlertTriangle,
              color: valueAtRisk > 0 ? '#DC2626' : '#059669',
              note: valueAtRisk > 0 ? 'spend needed to rescue critical SKUs' : 'nothing critical in this scope',
            },
            {
              label: <HelpTip tip="MAPE">Portfolio WMAPE</HelpTip>,
              value: `${wmape.toFixed(1)}%`,
              icon: Gauge,
              color: wmape <= 12 ? '#059669' : wmape <= 20 ? '#D97706' : '#DC2626',
              note: 'value-weighted · lower is better · <12% best-in-class',
            },
            {
              label: <HelpTip tip="Forecast Bias">Mean forecast bias</HelpTip>,
              value: `${meanBias > 0 ? '+' : ''}${meanBias.toFixed(1)}%`,
              icon: meanBias < 0 ? TrendingDown : TrendingUp,
              color: Math.abs(meanBias) <= 3 ? '#059669' : '#D97706',
              note: meanBias > 3 ? 'over-forecasting → excess risk' : meanBias < -3 ? 'under-forecasting → stockout risk' : 'well-centred forecasts',
            },
          ].map(({ label, value, icon: Icon, color, note }, i) => (
            <div key={i} style={tile}>
              <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Icon size={10} color={color} /> {label}
              </div>
              <div style={{ fontSize: 17, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
              {note && <div style={{ fontSize: 11, color: c.textMuted, marginTop: 3 }}>{note}</div>}
            </div>
          ))}
        </div>

        {/* Health mix bar */}
        <div>
          <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 5 }}>
            <HelpTip tip="Stock Status">Stock-health mix</HelpTip> — {skuCount.toLocaleString()} SKU{skuCount !== 1 ? 's' : ''} in scope
          </div>
          <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', border: `1px solid ${c.borderSubtle}` }}>
            {mix.filter(m => m.count > 0).map(m => (
              <div key={m.label} title={`${m.label}: ${m.count} SKU${m.count !== 1 ? 's' : ''}`}
                style={{ width: `${(m.count / total) * 100}%`, background: m.color }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
            {mix.map(m => (
              <span key={m.label} style={{ fontSize: 11, color: c.textSecondary, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: m.color, display: 'inline-block' }} />
                {m.label} {m.count}
              </span>
            ))}
          </div>
        </div>

        {/* ── Tuning loop — the per-SKU bias that drives the buffer nudge ────── */}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${c.borderSubtle}` }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: c.textPrimary, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <FlaskConical size={13} color="#B45309" /> Forecast tuning loop
          </div>
          <div style={{ fontSize: 11, color: c.textMuted, marginTop: 3 }}>
            The top 20% of SKUs by tuning impact — click a bubble to open its forecast detail
          </div>
        </div>

        {isError ? (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 10, padding: '9px 11px', borderRadius: 8, background: c.danger.bg, border: `1px solid ${c.danger.border}` }}>
            <span style={{ fontSize: 12, color: c.danger.text }}>
              Couldn’t load the tuning loop. The health figures above are unaffected.
            </span>
            <button onClick={() => refetch()}
              style={{ fontSize: 11, fontWeight: 700, padding: '4px 11px', borderRadius: 6, cursor: 'pointer', background: c.surface, color: c.danger.text, border: `1px solid ${c.danger.border}` }}>
              Retry
            </button>
          </div>
        ) : (isLoading || !data) ? (
          <div aria-busy="true" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} style={{ height: 11, borderRadius: 4, background: c.surfaceSubtle, width: `${100 - i * 11}%`, opacity: 0.8 - i * 0.09 }} />
            ))}
          </div>
        ) : (
          <>
            {/* Quadrant: how wrong (MAPE, y) × which way (bias, x) × how much it
                costs (bubble = stock value). Grid and axes are solid hairlines;
                the only dashed rules are the ±3% tolerance edges, which really
                are thresholds. Axis titles are deliberately plain — the legend
                below is the single place that spells out what each colour and
                side means, so there's one wording to read, not two. */}
            <ResponsiveContainer width="100%" height={264}>
              <ScatterChart margin={{ top: 8, right: 16, left: 2, bottom: 30 }}>
                <CartesianGrid stroke={c.borderSubtle} />
                <XAxis
                  type="number" dataKey="bias" name="Forecast bias"
                  domain={[-biasMax, biasMax]} tick={{ fontSize: 11 }}
                  tickFormatter={(v: any) => `${v > 0 ? '+' : ''}${Math.round(v)}%`}
                  label={{ value: 'Forecast bias', position: 'insideBottom', offset: -20, fontSize: 11, fill: c.textMuted }}
                />
                <YAxis
                  type="number" dataKey="mape" name="MAPE"
                  domain={[0, mapeMax]} tick={{ fontSize: 11 }} width={44}
                  tickFormatter={(v: any) => `${Math.round(v)}%`}
                  label={{ value: 'MAPE', angle: -90, position: 'insideLeft', fontSize: 11, fill: c.textMuted }}
                />
                <ZAxis type="number" dataKey="value" domain={[0, valueMax]} range={[110, 900]} name="Stock value" />
                {/* ±3% is the hold band — inside it, tuning is noise, not signal */}
                <ReferenceArea x1={-3} x2={3} fill={c.success.solid} fillOpacity={0.07} />
                <ReferenceLine x={-3} stroke="#D97706" strokeDasharray="3 3" />
                <ReferenceLine x={3} stroke="#D97706" strokeDasharray="3 3" />
                <ReferenceLine x={0} stroke={c.textMuted} />
                <Tooltip
                  cursor={{ stroke: c.borderSubtle }}
                  content={({ active, payload }: any) => {
                    const p = active && payload?.[0]?.payload
                    if (!p) return null
                    return (
                      <div style={{ ...chartTooltipStyle(c), padding: '7px 10px', color: c.textPrimary, maxWidth: 230 }}>
                        <div style={{ fontWeight: 800 }}>{p.sku}</div>
                        {p.description && <div style={{ color: c.textSecondary, marginBottom: 4 }}>{p.description}</div>}
                        <div>Bias <b>{p.bias > 0 ? '+' : ''}{p.bias}%</b> · MAPE <b>{p.mape}%</b></div>
                        <div>Stock value <b>{fmtGBP(p.value)}</b></div>
                        <div style={{ color: BIAS_STATES[p.state as BiasState].color, fontWeight: 700, marginTop: 3 }}>
                          {p.nudge}
                        </div>
                      </div>
                    )
                  }}
                />
                {(Object.keys(BIAS_STATES) as BiasState[]).map(state => (
                  <Scatter
                    key={state} name={BIAS_STATES[state].label}
                    data={points.filter((p: any) => p.state === state)}
                    fill={BIAS_STATES[state].color} fillOpacity={0.55}
                    stroke={c.surface} strokeWidth={2}   /* surface ring, not a border */
                    cursor="pointer"
                    onClick={(pt: any) => goToSku(pt.skuCode)}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
              <div style={{ display: 'flex', gap: 14, fontSize: 11, color: c.textSecondary, flexWrap: 'wrap' }}>
                {(Object.keys(BIAS_STATES) as BiasState[]).map(state => (
                  <span key={state} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: BIAS_STATES[state].color, flexShrink: 0 }} />
                    {BIAS_STATES[state].label}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 11, color: c.textMuted }}>
                Bubble size = stock value ({fmtGBP(valueRange[0])} – {fmtGBP(valueRange[1])}) ·
                top {points.length} of {data.row_count?.toLocaleString() ?? '—'} SKUs by tuning impact · click a bubble for detail
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
