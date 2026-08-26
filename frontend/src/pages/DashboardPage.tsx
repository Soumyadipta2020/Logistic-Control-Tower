import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '../components/ui/PageHeader'
import { MetricTip } from '../components/ui/InfoTooltip'
import {
  fetchExecutiveKPIs, fetchExceptions, fetchWarehouseHealth, fetchInventorySummary, fetchActiveScenario,
  fetchOperationalKPIs, fetchTransportKPIs, fetchFleetSummary, fetchSuppliers,
  fetchFinancials, fetchPlannerWorklist, fetchJobsAtRisk, api,
} from '../lib/api'
import {
  ArrowRight, Package, HardHat, TrendingUp, TrendingDown, Minus, AlertTriangle,
  Wrench, Truck, Leaf, CheckCircle, ShieldCheck, ShieldAlert, Zap, Sparkles, AlertCircle,
  Factory, PoundSterling, CalendarClock,
} from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip as RcTooltip, ResponsiveContainer, Cell } from 'recharts'
import { useTheme } from '../hooks/useTheme'
import { useStore } from '../store/useStore'
import { usePermissions } from '../hooks/usePermissions'
// The insight engine is shared with the AI Command Center, which now hosts the
// AI Insights & Recommendations panel this page used to render inline.
import { fmtMoney, LOWER_IS_BETTER, RAG_ACCENT, systemRagFrom } from '../lib/insights'

type Rag = 'G' | 'A' | 'R'

// ─── Sparkline helpers ────────────────────────────────────────────────────────

function seededRng(seed: string) {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = Math.imul(31, h) + seed.charCodeAt(i) | 0
  return () => { h ^= h << 13; h ^= h >> 17; h ^= h << 5; return (h >>> 0) / 4294967296 }
}

function makeSparkline(key: string, value: number, trend: string, points = 12): number[] {
  const rng = seededRng(key)
  const pts: number[] = [value]
  for (let i = 1; i < points; i++) {
    const noise = (rng() - 0.5) * (value * 0.04)
    const drift = trend === 'up' ? -(value * 0.008) : trend === 'down' ? (value * 0.008) : 0
    pts.unshift(Math.max(0, pts[0] + drift + noise))
  }
  return pts
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 35, H = 16
  const min = Math.min(...values), max = Math.max(...values)
  const range = max - min || 1
  const paddingX = 2 // leave space for the circle on the right edge
  const effectiveW = W - paddingX
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * effectiveW},${H - ((v - min) / range) * (H - 4) - 2}`)
    .join(' ')
  const lastX = effectiveW
  const lastY = H - ((values[values.length - 1] - min) / range) * (H - 4) - 2
  return (
    <svg width={W} height={H} style={{ display: 'block', flexShrink: 0 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5}
        strokeLinejoin="round" strokeLinecap="round" opacity={0.8} />
      <circle cx={lastX} cy={lastY} r={2} fill={color} />
    </svg>
  )
}

/**
 * Whether this metric moving in this direction is good news.
 *
 * Returns a tone name rather than a hex: the card reads it from `data-tone` and
 * takes the accessible `--status-*-text` step for it, which the hardcoded
 * #059669 / #DC2626 could not do — those are fixed for a light surface and sit
 * at 3.7:1 and 4.0:1 on the dark theme's card.
 */
function getTrendTone(key: string, trend: string): 'good' | 'bad' | 'flat' {
  if (trend === 'stable') return 'flat'
  const improving = LOWER_IS_BETTER.has(key) ? trend === 'down' : trend === 'up'
  return improving ? 'good' : 'bad'
}

function formatCompactNumber(num: number) {
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(num).toLowerCase()
}

/**
 * The gap to target, phrased from the metric's own direction of travel.
 *
 * `fmt` exists for the money measures only. Without it the £ cards read
 * "669519.0 below target" — a twelve-character figure in an 11px chip, and the one
 * thing about the original card that could not survive contact with a £ KPI.
 */
function getDelta(key: string, value: number, target: number, fmt?: (n: number) => string) {
  const lowerBetter = LOWER_IS_BETTER.has(key)
  const diff = lowerBetter ? target - value : value - target
  const abs = fmt ? fmt(Math.abs(diff)) : Math.abs(diff).toFixed(1)
  return {
    onTrack: diff >= 0,
    label: diff >= 0
      ? `${abs} ${lowerBetter ? 'below' : 'above'} target`
      : `${abs} ${lowerBetter ? 'above' : 'below'} target`,
  }
}

// ─── Level 1: the eight north-star KPIs ───────────────────────────────────────
// First Time Fix Rate plus the single most important measure of every operating
// module. Eight, not the full fourteen executive KPIs: a hero row that has to be
// read rather than scanned stops being a hero row, and the other six measures are
// diagnostic detail that belongs in their module's panel below.
//
// The card itself is the one this page has always had. Only the SELECTION changed.

interface HeroKpi {
  key: string
  /** Card label. */
  label: string
  /** Rendered small, after the value. */
  unit: string
  /** KPI_DEFINITIONS key for the hover/focus explainer. */
  tip: string
  tipTitle?: string
  icon: React.ElementType
  /** The module that owns the number, and where the card drills through to. */
  module: string
  route: string
  valueText: string
  targetText?: string
  delta?: { onTrack: boolean; label: string }
  rag?: Rag
  trend?: string
  spark: number[]
}

const count = (n: number) => n.toLocaleString()

// ─── Dashboard ────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const navigate = useNavigate()
  const { c } = useTheme()
  // The banner's "AI Insights" pill opens the Command Center, where the insight
  // panel now lives.
  const aiMode = useStore((s) => s.aiMode)
  const openAiPanel = useStore((s) => s.openAiPanel)
  const { canAccessPage } = usePermissions()
  const canUseAi = canAccessPage('/ai')

  const { data: kpis } = useQuery({ queryKey: ['executive-kpis'], queryFn: fetchExecutiveKPIs, refetchInterval: 30_000 })
  const { data: exceptions } = useQuery({ queryKey: ['exceptions-page'], queryFn: () => fetchExceptions(), refetchInterval: 15_000 })
  const { data: warehouseHealth } = useQuery({ queryKey: ['warehouse-health'], queryFn: fetchWarehouseHealth, refetchInterval: 30_000 })
  // Server-side aggregate over the whole catalogue — stays correct (and small)
  // however many thousand SKUs the catalogue holds.
  const { data: inventorySummary } = useQuery({ queryKey: ['inventory-summary', {}], queryFn: () => fetchInventorySummary(), refetchInterval: 60_000 })
  const { data: activeScn } = useQuery({ queryKey: ['active-scenario'], queryFn: fetchActiveScenario, refetchInterval: 15_000 })
  // Today's appointments in SLA jeopardy, and what is putting them there. The union
  // of the Field Ops and Transport Control causes is taken server-side because the
  // two sets overlap — see fetchJobsAtRisk. Polled fast: this is a live queue that
  // a dispatcher is actively working down.
  const { data: jobRisk } = useQuery({ queryKey: ['jobs-at-risk'], queryFn: () => fetchJobsAtRisk(), refetchInterval: 20_000 })

  // ── Module detail (level 2) ────────────────────────────────────────────────
  // Every one of these feeds the panel of the module that owns it. The tier-2
  // "Operational KPIs" and tier-3 "Procurement" dumps this page used to carry are
  // gone: a metric is only findable if it sits with the module it belongs to.
  const { data: opKPIs } = useQuery({ queryKey: ['operational-kpis'], queryFn: fetchOperationalKPIs, refetchInterval: 60_000 })
  const { data: procKPIs } = useQuery({
    queryKey: ['procurement-kpis'],
    queryFn: async () => { const r = await api.get('/api/v1/analytics/procurement-kpis'); return r.data.data },
    refetchInterval: 60_000,
  })
  const { data: fleetSummary } = useQuery({ queryKey: ['fleet-summary'], queryFn: fetchFleetSummary, refetchInterval: 60_000 })
  const { data: transportKPIs } = useQuery({ queryKey: ['transport-kpis'], queryFn: fetchTransportKPIs, refetchInterval: 60_000 })
  const { data: fieldKPIs } = useQuery({
    queryKey: ['field-dispatcher-kpis'],
    queryFn: async () => { const r = await api.get('/api/v1/analytics/field-dispatcher-kpis'); return r.data.data },
    refetchInterval: 60_000,
  })
  const { data: sustKPIs } = useQuery({
    queryKey: ['sustainability-kpis'],
    queryFn: async () => { const r = await api.get('/api/v1/analytics/sustainability-kpis'); return r.data.data },
    refetchInterval: 120_000,
  })
  const { data: suppliers } = useQuery({ queryKey: ['suppliers-dashboard'], queryFn: () => fetchSuppliers(), refetchInterval: 60_000 })
  const { data: demandFin } = useQuery({ queryKey: ['demand-financials', {}], queryFn: () => fetchFinancials(), refetchInterval: 60_000 })
  const { data: demandWork } = useQuery({ queryKey: ['planner-worklist-summary'], queryFn: () => fetchPlannerWorklist({}, 1, 1), refetchInterval: 60_000 })

  // ── derived state ──────────────────────────────────────────────────────────
  const kpiEntries = useMemo(() => kpis ? Object.entries(kpis) : [], [kpis])

  // Stable array references — prevents downstream useMemos from re-running on every render
  const allExceptions = useMemo(() => exceptions?.items ?? [], [exceptions])
  const openExceptions = useMemo(() => allExceptions.filter((e: any) => e.status === 'open'), [allExceptions])
  const openP1 = useMemo(() => openExceptions.filter((e: any) => e.priority === 'P1'), [openExceptions])
  const openP2 = useMemo(() => openExceptions.filter((e: any) => e.priority === 'P2'), [openExceptions])
  const openP3 = useMemo(() => openExceptions.filter((e: any) => e.priority === 'P3'), [openExceptions])
  const openP4 = useMemo(() => openExceptions.filter((e: any) => e.priority === 'P4'), [openExceptions])
  const warehouses = useMemo(() => warehouseHealth ?? [], [warehouseHealth])

  const { ragCounts, systemRag } = useMemo(() => systemRagFrom(kpiEntries, openP1), [kpiEntries, openP1])

  const systemLabel = systemRag === 'R' ? 'CRITICAL' : systemRag === 'A' ? 'AT RISK' : 'NORMAL'

  // ── inventory KPIs (server-side aggregates) ────────────────────────────────
  const invAtRisk = inventorySummary?.at_risk ?? 0
  const invStockouts = inventorySummary?.stockouts ?? 0
  const avgDoS = inventorySummary?.avg_days_of_supply ?? 0
  const fillRate = inventorySummary?.fill_rate_pct ?? 100

  // ── 3PL network rollup ─────────────────────────────────────────────────────
  // Volume-weighted, matching the server's own network-health calculation: one
  // small site at 50% is not the same event as every site at 50%, and a flat mean
  // across four sites cannot tell those two apart.
  const network = useMemo(() => {
    if (!warehouses.length) return null
    const den = warehouses.reduce((s: number, w: any) => s + (w.baseline_items_per_hour || 1), 0)
    const num = warehouses.reduce((s: number, w: any) => s + (w.throughput_vs_baseline_pct ?? 0) * (w.baseline_items_per_hour || 1), 0)
    const throughput = num / den
    const worst = Math.min(...warehouses.map((w: any) => w.throughput_vs_baseline_pct ?? 100))
    const courier = warehouses.reduce((s: number, w: any) => s + (w.courier_ot_rate ?? 0), 0) / warehouses.length
    return {
      throughput,
      worst,
      courier,
      // Same thresholds the backend grades network health on: <85% at risk, <60% critical.
      rag: (throughput >= 85 ? 'G' : throughput >= 60 ? 'A' : 'R') as Rag,
      worstRag: (worst >= 75 ? 'G' : worst >= 40 ? 'A' : 'R') as Rag,
      atTarget: warehouses.filter((w: any) => (w.throughput_vs_baseline_pct ?? 0) >= 85).length,
      disrupted: warehouses.filter((w: any) => w.is_disrupted).length,
    }
  }, [warehouses])

  // ── supplier rollups (Supplier Risk panel) ─────────────────────────────────
  // /risk/suppliers returns a paginated envelope: { items, total, page }
  const supplierList = useMemo(() => suppliers?.items ?? [], [suppliers])
  const supplierWatch = useMemo(
    () => [...supplierList].sort((a: any, b: any) => a.otif_score - b.otif_score).slice(0, 4),
    [supplierList]
  )
  const supplierFlags = useMemo(
    () => supplierList.filter((s: any) => s.financial_health_flag || s.geopolitical_risk_flag).length,
    [supplierList]
  )

  // ── the eight hero KPIs ────────────────────────────────────────────────────
  const heroKpis = useMemo<HeroKpi[]>(() => {
    const k: any = kpis ?? {}
    const t: any = transportKPIs ?? {}
    const out: HeroKpi[] = []

    const mk = (o: {
      key: string; label: string; unit?: string; tip: string; tipTitle?: string
      icon: React.ElementType; module: string; route: string
      value: number; target?: number
      /** Money measures only — see getDelta. Everything else uses the compact form. */
      fmt?: (n: number) => string
      /** Overrides the derived "Target: …" line where the bar needs its own wording. */
      targetText?: string
      rag?: Rag; trend?: string
    }): HeroKpi => {
      const fmt = o.fmt ?? formatCompactNumber
      const unit = o.unit ?? ''
      return {
        key: o.key, label: o.label, unit, tip: o.tip, tipTitle: o.tipTitle,
        icon: o.icon, module: o.module, route: o.route,
        valueText: fmt(o.value),
        targetText: o.targetText
          ?? (o.target != null ? `Target: ${fmt(o.target)}${unit ? ` ${unit}` : ''}` : undefined),
        delta: o.target != null ? getDelta(o.key, o.value, o.target, o.fmt) : undefined,
        rag: o.rag, trend: o.trend,
        spark: makeSparkline(o.key, o.value, o.trend ?? 'stable'),
      }
    }

    // 1 · Field Operations — the measure the whole service model is judged on.
    if (typeof k.first_time_fix_rate?.value === 'number') out.push(mk({
      key: 'first_time_fix_rate', label: 'First Time Fix Rate', unit: '%', tip: 'First Time Fix Rate',
      icon: Wrench, module: 'Live Field Ops', route: '/visibility',
      value: k.first_time_fix_rate.value, target: k.first_time_fix_rate.target,
      rag: k.first_time_fix_rate.rag, trend: k.first_time_fix_rate.trend,
    }))

    // 2 · Today's work, live. The only card on the row that is about jobs still
    // saveable rather than a period average — and the only one that belongs to two
    // modules at once, so it drills through to the Live Field Ops where the
    // larger half of the exposure is worked.
    if (jobRisk && typeof jobRisk.at_risk === 'number') out.push(mk({
      key: 'jobs_at_sla_risk', label: 'Jobs at SLA Risk', tip: 'Jobs at SLA Risk',
      icon: CalendarClock, module: 'Live Field Ops', route: '/visibility',
      value: jobRisk.at_risk,
      // "remaining", not a bare count: the denominator is the work still outstanding,
      // not the day's schedule, and 493 unqualified reads as the latter.
      unit: `of ${count(jobRisk.total_jobs ?? 0)} remaining`,
      target: jobRisk.target_jobs,
      // A whole-number count: the default 1-decimal delta would read "14.0 above
      // target" for fourteen appointments.
      fmt: count,
      targetText: `Target: ≤ ${count(jobRisk.target_jobs ?? 0)} (${jobRisk.target_pct}% of jobs remaining)`,
      rag: jobRisk.rag,
    }))

    // 3 · Transport Control — the promise made to the customer.
    if (typeof t.on_time_delivery_pct?.value === 'number') out.push(mk({
      key: 'on_time_delivery_pct', label: 'On-Time Delivery', unit: '%', tip: 'On-Time Delivery',
      icon: Truck, module: 'Transport Control', route: '/transport',
      value: t.on_time_delivery_pct.value, target: t.on_time_delivery_pct.target,
      rag: t.on_time_delivery_pct.rag, trend: t.on_time_delivery_pct.trend,
    }))

    // 4 · 3PL & Warehouse — network fulfilment capacity as one figure.
    if (network) out.push(mk({
      key: 'network_throughput', label: 'Network Throughput', unit: '%', tip: 'Network Throughput',
      icon: Factory, module: '3PL & Warehouse', route: '/visibility',
      value: network.throughput, target: 85, rag: network.rag,
    }))

    // 5 · Exceptions — the lagging half of the pair. Jobs at SLA Risk says what is
    // still saveable; this says what was not.
    if (typeof k.sla_breach_rate_pct?.value === 'number') out.push(mk({
      key: 'sla_breach_rate_pct', label: 'SLA Breach Rate', unit: '%', tip: 'SLA Breach Rate',
      icon: AlertTriangle, module: 'Exceptions', route: '/exceptions',
      value: k.sla_breach_rate_pct.value, target: k.sla_breach_rate_pct.target,
      rag: k.sla_breach_rate_pct.rag, trend: k.sla_breach_rate_pct.trend,
    }))

    // 6 · Demand & Inventory — the exposure, not the balance. Working capital says
    // how much stock there is; this says how much of the service is at stake.
    if (typeof k.inventory_value_at_risk_gbp?.value === 'number') out.push(mk({
      key: 'inventory_value_at_risk_gbp', label: 'Inventory at Risk', tip: 'Value at Risk',
      icon: PoundSterling, module: 'Demand & Inventory', route: '/demand',
      value: k.inventory_value_at_risk_gbp.value, target: k.inventory_value_at_risk_gbp.target,
      fmt: fmtMoney, rag: k.inventory_value_at_risk_gbp.rag, trend: k.inventory_value_at_risk_gbp.trend,
    }))

    // 7 · Supplier & Labour Risk — whether inbound supply is keeping its promises.
    if (typeof k.supplier_otif?.value === 'number') out.push(mk({
      key: 'supplier_otif', label: 'Supplier OTIF', unit: '%', tip: 'Supplier OTIF',
      icon: ShieldCheck, module: 'Supplier & Labour Risk', route: '/risk',
      value: k.supplier_otif.value, target: k.supplier_otif.target,
      rag: k.supplier_otif.rag, trend: k.supplier_otif.trend,
    }))

    // 8 · Sustainability — the People & Planet commitment in one number.
    if (typeof k.landfill_diversion_pct?.value === 'number') out.push(mk({
      key: 'landfill_diversion_pct', label: 'Landfill Diversion', unit: '%', tip: 'Landfill Diversion',
      icon: Leaf, module: 'Sustainability', route: '/sustainability',
      value: k.landfill_diversion_pct.value, target: k.landfill_diversion_pct.target,
      rag: k.landfill_diversion_pct.rag, trend: k.landfill_diversion_pct.trend,
    }))

    return out
  }, [kpis, transportKPIs, jobRisk, network])

  // ── warehouse chart data ───────────────────────────────────────────────────
  const whChartData = useMemo(() => warehouses.map((wh: any) => ({
    code: wh.code,
    actual: wh.items_per_hour ?? 0,
    baseline: wh.baseline_items_per_hour ?? 0,
    pct: wh.throughput_vs_baseline_pct ?? 0,
    rag: (wh.throughput_vs_baseline_pct ?? 0) < 40 ? 'R' : (wh.throughput_vs_baseline_pct ?? 0) < 75 ? 'A' : 'G',
  })), [warehouses])

  // ── Jobs-at-risk, per cause ────────────────────────────────────────────────
  // Each cause is graded against the SAME tolerance as the headline, not against a
  // threshold invented for it: one cause consuming half the whole allowance is
  // amber, one consuming all of it is red. That keeps the two module panels and the
  // hero card telling one story — and it is why these are not just `band()`ed on a
  // round number of jobs, which would mean something different on a 400-job day than
  // on an 800-job one. The tolerance is read from `target_pct` rather than hardcoded
  // so it cannot drift from the headline's: both are a share of the jobs still
  // OUTSTANDING, which is the same denominator `total_jobs` now carries.
  const causeRag = (n: number | undefined): Rag | undefined => {
    if (!jobRisk || n == null || !jobRisk.total_jobs) return undefined
    const share = n / jobRisk.total_jobs * 100
    const tol = jobRisk.target_pct ?? 5
    return share > tol ? 'R' : share > tol / 2 ? 'A' : 'G'
  }
  const partsRag = causeRag(jobRisk?.parts_shortage)
  const arrivalRag = causeRag(jobRisk?.arrival_delay)

  // Panel-level rollups, so a reader can tell which panel needs opening without
  // reading every figure inside it. Each stays `undefined` until its data lands —
  // a pill that says "On track" while the panel is still empty is a claim the page
  // cannot yet support.
  const invRag = inventorySummary
    ? (invStockouts > 0 || fillRate < 80 ? 'R' : invAtRisk > 0 || fillRate < 95 ? 'A' : 'G') as Rag
    : undefined
  const fieldRag = ragOf(
    partsRag,
    band(fieldKPIs?.van_stock_low_count, 80, 200),
    band(fieldKPIs?.locker_gaps_count, 60, 500),
    opKPIs?.in_boot_availability?.rag, opKPIs?.van_fill_accuracy?.rag, opKPIs?.pre_8am_delivery_success?.rag,
  )
  // Open defects are deliberately NOT graded here. The tile shows the count without
  // a RAG because nothing in this product defines a target for it, and the obvious
  // guess is wrong: 50 open defects across 200 vans is a normal maintenance backlog,
  // so any round-number threshold pins this panel red every day. VOR — vehicles
  // actually off the road — is the graded version of the same concern.
  const transportRag = ragOf(
    arrivalRag,
    transportKPIs?.on_time_delivery_pct?.rag, transportKPIs?.fleet_utilization_pct?.rag,
    band(fleetSummary?.vor_count, 5, 10),
  )
  const supplierRag = ragOf(
    kpis?.supplier_otif?.rag,
    band(supplierFlags, 0, 1),
    band(procKPIs?.ariba_expired, 0, 0),
    band(procKPIs?.emergency_pos_pct, 8, 15),
  )
  const sustRag: Rag | undefined = !sustKPIs ? undefined
    : !sustKPIs.people_planet_plan_on_track ? 'R'
      : ragOf(kpis?.scope3_ytd_tco2e?.rag, kpis?.landfill_diversion_pct?.rag)

  return (
    <>
      <PageHeader
        title="Executive Dashboard"
        subtitle={`EXL Logistics Control Tower · ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}`}
      />
      <div className="page-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Zone 1: System Status Banner ─────────────────────────────────────
            The dashboard reports the FACTS — status, KPI grid, module rollups.
            The interpretation of those facts (what it means, what to do, over
            what horizon) is ATLAS's job, so AI Insights & Recommendations now
            lives in the AI Command Center and this banner links across to it. */}
        <div data-tour="dash-status" style={{
          background: 'var(--clt-surface)',
          borderRadius: 10,
          border: '1px solid var(--clt-grey-200)',
          borderTop: `3px solid ${RAG_ACCENT[systemRag]}`,
          overflow: 'hidden',
          flexShrink: 0,
        }}>
          {/* Status strip — compact, single line, colour reserved for this row only. */}
          <div style={{
            background: c.ragBg[systemRag],
            borderBottom: `1px solid ${c.ragBorder[systemRag]}`,
            padding: '9px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}>
            {systemRag === 'G'
              ? <ShieldCheck size={15} color={RAG_ACCENT.G} />
              : systemRag === 'A'
                ? <ShieldAlert size={15} color={RAG_ACCENT.A} />
                : <Zap size={15} color={RAG_ACCENT.R} />
            }
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.04em', color: c.ragText[systemRag] }}>
              OPERATIONS STATUS: {systemLabel}
            </span>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 4 }}>
              {/* Priority chips are drill-downs into the exceptions workspace */}
              <StatusChip
                color={openP1.length > 0 ? c.danger.text : c.chipText}
                bg={openP1.length > 0 ? c.danger.bg : c.chipBg}
                border={openP1.length > 0 ? c.danger.border : c.chipBorder}
                label={`${openP1.length} P1 open`}
                onClick={() => navigate('/exceptions')}
              />
              <StatusChip
                color={openP2.length > 0 ? c.warning.text : c.chipText}
                bg={openP2.length > 0 ? c.warning.bg : c.chipBg}
                border={openP2.length > 0 ? c.warning.border : c.chipBorder}
                label={`${openP2.length} P2 open`}
                onClick={() => navigate('/exceptions')}
              />
              <StatusChip
                color={openP3.length > 0 ? c.warning.text : c.chipText}
                bg={openP3.length > 0 ? c.warning.bg : c.chipBg}
                border={openP3.length > 0 ? c.warning.border : c.chipBorder}
                label={`${openP3.length} P3 open`}
                onClick={() => navigate('/exceptions')}
              />
              <StatusChip
                color={c.chipText}
                bg={c.chipBg}
                border={c.chipBorder}
                label={`${openP4.length} P4 open`}
                onClick={() => navigate('/exceptions')}
              />
              {activeScn?.scenario_id && (
                <StatusChip
                  color={c.info.text}
                  bg={c.info.bg}
                  border={c.info.border}
                  label={`Scenario: ${activeScn.name}`}
                />
              )}
              <StatusChip
                color={c.ragText[systemRag]}
                bg={c.ragBg[systemRag]}
                border={c.ragBorder[systemRag]}
                label={`${ragCounts.G}G · ${ragCounts.A}A · ${ragCounts.R}R across ${kpiEntries.length} KPIs`}
              />
              {/* The way through to the interpretation of everything to its left.
                  Only rendered when ATLAS is on and the user can reach it — an
                  affordance that opens a panel which is not there would be worse
                  than no affordance at all. */}
              {canUseAi && aiMode && (
                <button
                  onClick={() => openAiPanel('overview')}
                  title="Open AI Insights & Recommendations in the ATLAS Command Center"
                  className="ai-insights-pill"
                >
                  <Sparkles size={11} strokeWidth={2.2} />
                  AI Insights
                  <ArrowRight size={10} strokeWidth={2.2} />
                </button>
              )}
            </div>

            {/* Timestamp */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: c.ragText[systemRag], opacity: 0.65, marginLeft: 'auto' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: RAG_ACCENT[systemRag], display: 'inline-block' }} />
              Live · {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>

        </div>

        {/* ── Level 1: eight north-star KPIs ──────────────────────────────── */}
        <div className="dash-band">
          <span className="dash-band__title">Network Scorecard</span>
          <span className="dash-band__note">First-time fix plus the leading measure of every module · click a card to open its module</span>
          <span className="dash-band__rule" />
        </div>

        {/* The wrapper exists only to be a query container: it is what lets the
            row below ask how much width IT has (8 / 4 / 2 / 1 across) instead of
            asking the viewport, which cannot see the sidebar. The row's tracks
            and the cards' own breakpoints live in dashboard.css — nothing here is
            an inline `grid-template-columns` any more, because a media or
            container query can never reach one. */}
        <div className="exec-scorecard-wrap">
          <div data-tour="dash-scorecard" className="auto-grid exec-scorecard">
            {heroKpis.map((kpi) => {
              const trendTone = kpi.trend ? getTrendTone(kpi.key, kpi.trend) : undefined
              // The rail, the icon and the figure all read their colour from
              // --exec-accent, set by data-rag in CSS.
              const ragColor = kpi.rag ? RAG_ACCENT[kpi.rag] : '#6B7280'

              return (
                <MetricTip
                  key={kpi.key}
                  label={kpi.tip}
                  title={kpi.tipTitle ?? kpi.label}
                  block
                  onActivate={() => navigate(kpi.route)}
                  // aria-label replaces the card's inner text for a screen reader, so
                  // everything the card shows visually has to be said here.
                  activateLabel={[
                    `${kpi.label}: ${kpi.valueText}${kpi.unit ? ` ${kpi.unit}` : ''}.`,
                    kpi.delta ? `${kpi.delta.label}.` : '',
                    `Open ${kpi.module}`,
                  ].filter(Boolean).join(' ')}
                >
                  <div className="exec-kpi" data-rag={kpi.rag}>
                    {/* Label row */}
                    <div className="exec-kpi__head">
                      <span className="exec-kpi__icon" aria-hidden="true">
                        <kpi.icon size={13} strokeWidth={1.8} />
                      </span>
                      <span className="exec-kpi__label">{kpi.label}</span>
                    </div>

                    {/* Value + Sparkline */}
                    <div className="exec-kpi__figure">
                      <div className="exec-kpi__value-row">
                        <span className="exec-kpi__value">{kpi.valueText}</span>
                        {kpi.unit && <span className="exec-kpi__unit">{kpi.unit}</span>}
                      </div>
                      {kpi.spark.length > 1 && (
                        <div className="exec-kpi__spark" aria-hidden="true">
                          <Sparkline values={kpi.spark} color={ragColor} />
                        </div>
                      )}
                    </div>

                    {/* Target */}
                    {kpi.targetText && (
                      <div className="exec-kpi__target">{kpi.targetText}</div>
                    )}

                    {/* Delta + Trend */}
                    <div className="exec-kpi__foot">
                      {kpi.delta ? (
                        <span className="exec-kpi__delta" data-tone={kpi.delta.onTrack ? 'good' : 'bad'}>
                          {kpi.delta.onTrack
                            ? <CheckCircle size={10} strokeWidth={2.2} />
                            : <AlertCircle size={10} strokeWidth={2.2} />}
                          <span>{kpi.delta.label}</span>
                        </span>
                      ) : <span />}
                      {kpi.trend && (
                        <span className="exec-kpi__trend" data-tone={trendTone}>
                          {kpi.trend === 'up' ? <TrendingUp size={11} /> : kpi.trend === 'down' ? <TrendingDown size={11} /> : <Minus size={11} />}
                          <span>{kpi.trend === 'stable' ? 'Stable' : kpi.trend === 'up' ? 'Up' : 'Down'}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </MetricTip>
              )
            })}
          </div>
        </div>

        {/* ── Level 2: one panel per module ───────────────────────────────────
             Grouped by the module that owns the metric, and sectioned inside each
             panel, so a reader can predict where a number lives. Panels are dense
             on purpose: tight spacing, tabular numerals, hierarchy from weight and
             a single accent rather than whitespace. */}
        <div className="dash-band">
          <span className="dash-band__title">Module Detail</span>
          <span className="dash-band__note">Every tracked KPI, grouped under the module that owns it</span>
          <span className="dash-band__rule" />
        </div>

        <div className="mod-grid" data-tour="dash-modules">

          {/* ── Field Operations ──
               First, with Transport Control beside it, because between them they own
               today's jobs — the only thing on this page that can still be changed
               before the day is lost. Everything below these two is either a period
               average or a supply position.

               The tier-2 parts-at-point-of-use metrics (in-boot, van fill, pre-8AM,
               locker fill, transfers) belong here, with the engineers they are
               about — not in a separate "Operational KPIs" list. */}
          <ModulePanel
            icon={HardHat} accent={2} title="Field Operations" tour="dash-mod-field"
            sub={fieldKPIs ? `${fieldKPIs.active_engineers} engineers` : undefined}
            health={fieldRag} onOpen={() => navigate('/visibility')}
          >
            <Section label="Today · parts risk">
              <Tiles>
                <Tile label="Jobs · Parts" tip="Jobs at Risk · Parts" value={jobRisk ? count(jobRisk.parts_shortage) : '—'} rag={partsRag} />
                <Tile label="Rounds Short" tip="Rounds Short of Stock" value={jobRisk ? count(jobRisk.rounds_short_of_stock) : '—'} rag={jobRisk ? (jobRisk.rounds_short_of_stock > 0 ? 'A' : 'G') : undefined} />
                <Tile label="In-Boot Avail." tip="In-Boot Availability" value={opKPIs?.in_boot_availability?.value?.toFixed(1) ?? '—'} unit="%" rag={opKPIs?.in_boot_availability?.rag} />
                <Tile label="Van Fill Acc." tip="van_fill_accuracy" value={opKPIs?.van_fill_accuracy?.value?.toFixed(1) ?? '—'} unit="%" rag={opKPIs?.van_fill_accuracy?.rag} />
              </Tiles>
              {/* The overlap, stated. This panel's job count and Transport's are two
                  views of the same day's appointments, not two disjoint queues, so
                  adding them overshoots the hero card by exactly this number. Showing
                  it is what lets a reader close the arithmetic on the page instead of
                  concluding the page disagrees with itself. */}
              <Rows>
                <Row label="Also late in transit (in both counts)" tip="Jobs at Risk · Both Causes" value={jobRisk ? count(jobRisk.both_causes) : '—'} />
              </Rows>
            </Section>

            <Section label="Engineer coverage">
              <Tiles>
                <Tile label="Active" tip="Active Engineers" value={fieldKPIs?.active_engineers ?? '—'} />
                <Tile label="On-site" tip="Engineers On-Site" value={fieldKPIs?.engineers_on_site ?? '—'} />
                <Tile label="Available" tip="Available for Dispatch" value={fieldKPIs?.engineers_available ?? '—'} />
                <Tile label="Stock Low" tip="Van Stock Low" value={fieldKPIs?.van_stock_low_count ?? '—'} rag={band(fieldKPIs?.van_stock_low_count, 80, 200)} />
              </Tiles>
            </Section>

            {/* The locker network is how parts reach an engineer before the first job,
                so it sits with field ops and not with 3PL. */}
            <Section label="Locker network">
              <Rows>
                <Row label="Pre-8AM locker delivery" tip="Pre-8AM Delivery" value={opKPIs?.pre_8am_delivery_success?.value?.toFixed(1) ?? '—'} unit="%" rag={opKPIs?.pre_8am_delivery_success?.rag} warn={opKPIs?.pre_8am_delivery_success?.rag === 'R'} />
                <Row label="Locker fill rate" tip="locker_fill_rate" value={opKPIs?.locker_fill_rate?.value?.toFixed(1) ?? '—'} unit="%" rag={opKPIs?.locker_fill_rate?.rag} />
                <Row label="Locker gaps" tip="Locker Gaps" value={fieldKPIs?.locker_gaps_count ?? '—'} rag={band(fieldKPIs?.locker_gaps_count, 60, 500)} warn={(fieldKPIs?.locker_gaps_count ?? 0) > 500} />
                <Row label="Inter-engineer transfers (wk)" tip="inter_engineer_transfers" value={opKPIs?.inter_engineer_transfers?.value ?? '—'} />
              </Rows>
            </Section>
          </ModulePanel>

          {/* ── Transport Control ── */}
          <ModulePanel
            icon={Truck} accent={4} title="Transport Control" tour="dash-mod-transport"
            sub={fleetSummary ? `${fleetSummary.fleet_size} vans` : undefined}
            health={transportRag} onOpen={() => navigate('/transport')}
          >
            <Section label="Today · arrival risk">
              <Tiles>
                <Tile label="Jobs · Arrival" tip="Jobs at Risk · Arrival" value={jobRisk ? count(jobRisk.arrival_delay) : '—'} rag={arrivalRag} />
                <Tile label="Rounds Late" tip="Rounds Running Late" value={jobRisk ? count(jobRisk.rounds_delayed) : '—'} rag={jobRisk ? (jobRisk.rounds_delayed > 0 ? 'A' : 'G') : undefined} />
                <Tile label="Worst Slip" tip="Worst Slip" value={jobRisk ? count(jobRisk.worst_breach_mins) : '—'} unit="min" rag={jobRisk ? (jobRisk.worst_breach_mins >= 45 ? 'R' : jobRisk.worst_breach_mins > 0 ? 'A' : 'G') : undefined} />
                <Tile label="OTD" tip="On-Time Delivery" value={transportKPIs?.on_time_delivery_pct?.value?.toFixed(1) ?? '—'} unit="%" rag={transportKPIs?.on_time_delivery_pct?.rag} />
              </Tiles>
              {/* Mirror of the same overlap line in Field Operations — the count is
                  one number shared by both panels, so it is worded from each panel's
                  own side rather than duplicated verbatim. */}
              <Rows>
                <Row label="Also short of parts (in both counts)" tip="Jobs at Risk · Both Causes" value={jobRisk ? count(jobRisk.both_causes) : '—'} />
              </Rows>
            </Section>

            <Section label="Fleet readiness">
              <Tiles>
                <Tile label="Utilisation" tip="Fleet Utilisation" value={transportKPIs?.fleet_utilization_pct?.value?.toFixed(0) ?? '—'} unit="%" rag={transportKPIs?.fleet_utilization_pct?.rag} />
                <Tile label="VOR" tip="VOR" value={fleetSummary?.vor_count ?? '—'} rag={band(fleetSummary?.vor_count, 5, 10)} />
                <Tile label="Defects" tip="Open Defects" value={fleetSummary?.open_defects ?? '—'} />
                <Tile label="CAZ" tip="CAZ Non-Compliant" value={fleetSummary?.caz_non_compliant ?? '—'} />
              </Tiles>
              <Rows>
                <Row label="Walkaround compliance" tip="Walkaround Compliance" value={fleetSummary?.walkaround_compliance_pct != null ? `${fleetSummary.walkaround_compliance_pct.toFixed(0)}%` : '—'} warn={(fleetSummary?.walkaround_compliance_pct ?? 100) < 80} />
              </Rows>
            </Section>

            {/* Fuel sits here and not under delivery performance: it is what the
                driving COST, not whether the customer was served. */}
            <Section label="Cost & inbound">
              <Rows>
                <Row label="Fuel efficiency" tip="Fuel Efficiency" value={transportKPIs?.fuel_efficiency_mpg?.value?.toFixed(1) ?? '—'} unit="mpg" rag={transportKPIs?.fuel_efficiency_mpg?.rag} />
                <Row label="Freight spend (month)" tip="Freight Spend" value={transportKPIs?.freight_spend_gbp?.value != null ? fmtMoney(transportKPIs.freight_spend_gbp.value) : '—'} rag={transportKPIs?.freight_spend_gbp?.rag} />
                <Row label="Cost per install" tip="Cost per Install" value={kpis?.cost_per_install_gbp?.value != null ? `£${kpis.cost_per_install_gbp.value.toFixed(0)}` : '—'} rag={kpis?.cost_per_install_gbp?.rag} />
              </Rows>
            </Section>
          </ModulePanel>

          {/* ── Demand & Inventory ── */}
          <ModulePanel
            icon={Package} accent={1} title="Demand & Inventory" tour="dash-mod-demand"
            sub={`${(inventorySummary?.catalogue_size ?? 0).toLocaleString()} SKUs · NDC + 3 hubs`}
            health={invRag} onOpen={() => navigate('/demand')}
          >
            <Section label="Availability">
              <Tiles>
                {/* Every RAG here is gated on the summary having arrived. Graded off
                    the zero-defaults instead, an unloaded panel paints itself red. */}
                <Tile label="Fill Rate" tip="Fill Rate" value={inventorySummary ? fillRate.toFixed(0) : '—'} unit="%" rag={inventorySummary ? (fillRate < 80 ? 'R' : fillRate < 95 ? 'A' : 'G') : undefined} />
                <Tile label="Avg DoS" tip="Avg Days of Supply" value={inventorySummary ? avgDoS.toFixed(1) : '—'} unit="d" rag={inventorySummary ? (avgDoS < 3 ? 'R' : avgDoS < 7 ? 'A' : 'G') : undefined} />
                <Tile label="At-Risk" tip="At-Risk SKUs" value={inventorySummary ? count(invAtRisk) : '—'} rag={inventorySummary ? (invAtRisk > (inventorySummary.count ?? 0) * 0.08 ? 'R' : invAtRisk > 0 ? 'A' : 'G') : undefined} />
                <Tile label="Stockouts" tip="Stockouts" value={inventorySummary ? count(invStockouts) : '—'} rag={inventorySummary ? (invStockouts > 0 ? 'R' : 'G') : undefined} />
              </Tiles>
            </Section>

            <Section label="Planning accuracy">
              <Tiles cols={3}>
                <Tile label="Forecast Acc." tip="forecast_accuracy_30d" value={opKPIs?.forecast_accuracy_30d?.value?.toFixed(1) ?? '—'} unit="%" rag={opKPIs?.forecast_accuracy_30d?.rag} />
                <Tile label="Stock Acc." tip="Inventory Accuracy" value={kpis?.inventory_accuracy_pct?.value?.toFixed(1) ?? '—'} unit="%" rag={kpis?.inventory_accuracy_pct?.rag} />
                <Tile label="Expediting" tip="Expediting Cost" value={kpis?.expediting_cost_pct?.value?.toFixed(1) ?? '—'} unit="%" rag={kpis?.expediting_cost_pct?.rag} />
              </Tiles>
            </Section>

            <Section label="Working capital">
              <Tiles cols={2}>
                <Tile label="Turns" tip="Inventory Turns" value={kpis?.inventory_turns?.value?.toFixed(1) ?? '—'} unit="×" rag={kpis?.inventory_turns?.rag} />
                <Tile label="GMROI" tip="GMROI" value={kpis?.gmroi?.value?.toFixed(2) ?? '—'} unit="×" rag={kpis?.gmroi?.rag} />
              </Tiles>
              <Rows>
                <Row label="Working capital in stock" tip="Working Capital" value={demandFin ? fmtMoney(demandFin.stock_value_gbp) : '—'} />
                <Row label="Excess capital" tip="Excess Capital" value={demandFin ? fmtMoney(demandFin.excess_value_gbp) : '—'} warn={(demandFin?.excess_value_gbp ?? 0) > 0} />
                <Row label="Open planner actions" tip="Planner Worklist"
                  value={demandWork ? `${demandWork.total?.toLocaleString()} · ${demandWork.critical} critical` : '—'}
                  warn={(demandWork?.critical ?? 0) > 0} />
              </Rows>
            </Section>
          </ModulePanel>

          {/* ── 3PL & Warehouse ── */}
          <ModulePanel
            icon={Factory} accent={8} title="3PL & Warehouse" sub="Operator: TVS SCS" tour="dash-mod-3pl"
            health={network?.rag} onOpen={() => navigate('/visibility')}
          >
            <Section label="Network capacity">
              <Tiles cols={3}>
                <Tile label="Network" tip="Network Throughput" value={network ? network.throughput.toFixed(0) : '—'} unit="%" rag={network?.rag} />
                <Tile label="Lowest Site" tip="Lowest Site" value={network ? network.worst.toFixed(0) : '—'} unit="%" rag={network?.worstRag} />
                <Tile label="Courier OT" tip="Courier OT" value={network ? network.courier.toFixed(0) : '—'} unit="%" rag={network ? (network.courier < 90 ? 'A' : 'G') : undefined} />
              </Tiles>
            </Section>

            <Section label="Throughput vs baseline · items/hr">
              <ResponsiveContainer width="100%" height={88}>
                <BarChart data={whChartData} barGap={2} barCategoryGap="28%" margin={{ top: 2, right: 2, bottom: -6, left: -16 }}>
                  <XAxis dataKey="code" tick={{ fontSize: 11, fill: c.chartAxis }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: c.chartAxis }} tickLine={false} axisLine={false}
                    tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
                  <RcTooltip
                    formatter={(val: any, name: string) => [`${Number(val).toLocaleString()} items/hr`, name === 'actual' ? 'Actual' : 'Baseline']}
                    contentStyle={{ fontSize: 11, borderRadius: 6, background: c.surface, border: `1px solid ${c.border}`, color: c.textPrimary }}
                  />
                  <Bar dataKey="baseline" name="Baseline" fill={c.border} radius={[2, 2, 0, 0]} />
                  <Bar dataKey="actual" name="Actual" radius={[2, 2, 0, 0]}>
                    {whChartData.map((entry: any, i: number) => (
                      <Cell key={i} fill={RAG_ACCENT[entry.rag as keyof typeof RAG_ACCENT]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Section>

            <Section label="By site">
              <Rows>
                {warehouses.map((wh: any) => {
                  const p: number = wh.throughput_vs_baseline_pct
                  const rag: Rag = p < 40 ? 'R' : p < 75 ? 'A' : 'G'
                  return (
                    <Row
                      key={wh.code}
                      rag={rag}
                      tip="Throughput vs Baseline"
                      label={`${wh.code}${wh.courier_ot_rate != null ? ` · courier OT ${wh.courier_ot_rate.toFixed(0)}%` : ''}`}
                      value={`${p.toFixed(0)}%`}
                      warn={rag === 'R'}
                    />
                  )
                })}
              </Rows>
            </Section>
          </ModulePanel>

          {/* ── Supplier & Procurement Risk ──
               The tier-3 procurement block used to be its own orphan panel. It is
               the same story as supplier risk — inbound supply keeping its word —
               so it is sectioned inside this module instead. */}
          <ModulePanel
            icon={ShieldCheck} accent={6} title="Supplier & Procurement Risk" tour="dash-mod-supplier"
            sub={suppliers ? `${suppliers.total ?? supplierList.length} tracked` : undefined}
            health={supplierRag} onOpen={() => navigate('/risk')}
          >
            <Section label="Supplier reliability">
              <Tiles>
                <Tile label="Avg OTIF" tip="Avg OTIF" value={kpis?.supplier_otif?.value?.toFixed(1) ?? '—'} unit="%" rag={kpis?.supplier_otif?.rag} />
                <Tile label="Risk Flags" tip="Risk Flags" value={suppliers ? count(supplierFlags) : '—'} rag={suppliers ? band(supplierFlags, 0, 1) : undefined} />
                <Tile label="Ariba Exp." tip="Ariba Expired" value={procKPIs?.ariba_expired ?? '—'} rag={band(procKPIs?.ariba_expired, 0, 0)} />
                <Tile label="Ariba 30d" tip="Ariba Expiring 30d" value={procKPIs?.ariba_expiring_30d ?? '—'} rag={band(procKPIs?.ariba_expiring_30d, 5, 12)} />
              </Tiles>
            </Section>

            <Section label="Purchasing">
              <Tiles cols={2}>
                <Tile label="Open POs" tip="Open POs" value={procKPIs?.open_pos ?? '—'} />
                <Tile label="Emergency" tip="Emergency POs" value={procKPIs?.emergency_pos_pct?.toFixed(1) ?? '—'} unit="%" rag={band(procKPIs?.emergency_pos_pct, 8, 15)} />
              </Tiles>
            </Section>

            <Section label="OTIF watchlist · lowest first">
              <Rows>
                {supplierWatch.map((s: any) => (
                  <Row
                    key={s.supplier_code}
                    rag={s.otif_score < 70 ? 'R' : s.otif_score < 90 ? 'A' : 'G'}
                    tip="OTIF Score"
                    label={`${s.name}${s.financial_health_flag ? ' · £ risk' : ''}${s.geopolitical_risk_flag ? ' · geo' : ''}`}
                    value={`${s.otif_score?.toFixed(1)}%`}
                    warn={s.otif_score < 70 || s.financial_health_flag}
                  />
                ))}
              </Rows>
            </Section>
          </ModulePanel>

          {/* ── Sustainability ── */}
          <ModulePanel icon={Leaf} accent={3} title="Sustainability" sub="People & Planet plan" tour="dash-mod-sustainability" health={sustRag} onOpen={() => navigate('/sustainability')}>
            <Section label="Circularity">
              <Tiles cols={3}>
                {/* Read from the executive KPI, not from /sustainability-kpis. Both
                    report landfill diversion, but only the executive one is resynced
                    on every tick — sourcing the tile from the other made level 2
                    contradict the hero card above it about the same measure. */}
                <Tile label="Diversion" tip="Landfill Diversion" value={kpis?.landfill_diversion_pct?.value?.toFixed(1) ?? '—'} unit="%" rag={kpis?.landfill_diversion_pct?.rag} />
                <Tile label="Recon Parts" tip="Parts Reconditioned in Use" value={sustKPIs?.reconditioned_parts_used?.toLocaleString() ?? '—'} />
                <Tile label="WEEE" tip="WEEE Compliance" value={sustKPIs?.weee_compliant_pct?.toFixed(1) ?? '—'} unit="%" />
              </Tiles>
            </Section>

            <Section label="Carbon">
              <Tiles cols={2}>
                <Tile label="Scope 3 YTD" tip="Scope 3 YTD" value={kpis?.scope3_ytd_tco2e?.value?.toLocaleString() ?? '—'} unit="tCO₂e" rag={kpis?.scope3_ytd_tco2e?.rag} />
                <Tile label="CO₂ Saved" tip="CO₂ Saved YTD" value={sustKPIs ? (sustKPIs.co2_saved_vs_landfill_kg / 1000).toFixed(0) : '—'} unit="t" />
              </Tiles>
            </Section>

            <Section label="Value recovered">
              <Rows>
                <Row label="Reconditioned value recovered" tip="Reconditioned Value" value={sustKPIs?.reconditioned_value_gbp != null ? fmtMoney(sustKPIs.reconditioned_value_gbp) : '—'} />
                <Row label="People & Planet plan" tip="People & Planet Plan" value={sustKPIs ? (sustKPIs.people_planet_plan_on_track ? 'On track' : 'Off track') : '—'} warn={sustKPIs ? !sustKPIs.people_planet_plan_on_track : false} />
              </Rows>
            </Section>
          </ModulePanel>

        </div>
      </div>
    </>
  )
}

// ─── Level 2 primitives ───────────────────────────────────────────────────────

/** Worst status wins. Undefined until at least one input is known. */
function ragOf(...rags: (Rag | undefined)[]): Rag | undefined {
  const known = rags.filter((r): r is Rag => r != null)
  if (!known.length) return undefined
  if (known.includes('R')) return 'R'
  return known.includes('A') ? 'A' : 'G'
}

/** Grade a count against an amber and a red threshold (`> amber`, `> red`). */
function band(value: number | undefined, amber: number, red: number): Rag | undefined {
  if (value == null) return undefined
  return value > red ? 'R' : value > amber ? 'A' : 'G'
}

const HEALTH_LABEL: Record<Rag, string> = { G: 'On track', A: 'At risk', R: 'Action' }

// Dense module panel: header (icon · title · context · health · open) over a body
// of named sections. One panel per module, and every metric the dashboard shows
// lives in exactly one of them.
function ModulePanel({ icon: Icon, title, sub, accent, health, onOpen, tour, children }: {
  icon: React.ElementType; title: string; sub?: string; accent?: number
  health?: Rag; onOpen?: () => void; tour?: string; children: React.ReactNode
}) {
  return (
    <section className="mod-panel" data-accent={accent} data-tour={tour}>
      <div className="mod-panel__head">
        <span className="mod-panel__icon" aria-hidden="true"><Icon size={13} strokeWidth={1.9} /></span>
        <h3 className="mod-panel__title">{title}</h3>
        <span className="mod-panel__sub">{sub}</span>
        {health && (
          <span className="mod-panel__health" data-rag={health}>
            {HEALTH_LABEL[health]}
          </span>
        )}
        {onOpen && (
          <button type="button" className="mod-panel__open" onClick={onOpen}>
            Open <ArrowRight size={9} aria-hidden="true" />
            <span className="sr-only">{title}</span>
          </button>
        )}
      </div>
      <div className="mod-panel__body">{children}</div>
    </section>
  )
}

/** A named group of metrics — the thing that makes the panel predictable. */
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mod-section">
      <div className="mod-section__label">{label}</div>
      {children}
    </div>
  )
}

function Tiles({ cols, children }: { cols?: 2 | 3 | 4; children: React.ReactNode }) {
  return <div className="mod-tiles" data-cols={cols ?? 4}>{children}</div>
}

// Small labelled figure — RAG rail, tabular numerals for scanability. `tip` is a
// KPI_DEFINITIONS key: hovering the tile shows its explainer (no ⓘ icon — the
// metric itself is the hover target).
function Tile({ label, value, unit, rag, tip }: {
  label: string; value: string | number; unit?: string; rag?: Rag; tip?: string
}) {
  const tile = (
    <div className="mod-tile" data-rag={rag}>
      <div className="mod-tile__label">{label}</div>
      <div className="mod-tile__value">
        {value}
        {unit && <span className="mod-tile__unit">{unit}</span>}
      </div>
    </div>
  )
  return tip ? <MetricTip label={tip} title={label} block>{tile}</MetricTip> : tile
}

function Rows({ children }: { children: React.ReactNode }) {
  return <div className="mod-rows">{children}</div>
}

/** One dense label/value line; `warn` colours the value, `tip` adds the explainer. */
function Row({ label, value, unit, rag, warn, tip }: {
  label: string; value: string | number; unit?: string; rag?: Rag; warn?: boolean; tip?: string
}) {
  const row = (
    <div className="mod-row">
      {rag && <span className="mod-row__dot" data-rag={rag} aria-hidden="true" />}
      <span className="mod-row__label">{label}</span>
      <span className="mod-row__value" data-warn={warn ? 'true' : undefined}>
        {value}
        {unit && <span className="mod-row__unit">{unit}</span>}
      </span>
    </div>
  )
  return tip ? <MetricTip label={tip} title={label} block>{row}</MetricTip> : row
}

function StatusChip({ label, color, bg, border, onClick }: {
  label: string; color: string; bg: string; border: string; onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      style={{
        fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 20,
        color, background: bg, border: `1px solid ${border}`,
        cursor: onClick ? 'pointer' : undefined,
      }}
    >
      {label}
    </div>
  )
}
