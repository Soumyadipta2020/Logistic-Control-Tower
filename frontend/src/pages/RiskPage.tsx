import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '../components/ui/PageHeader'
import { ActionedToday } from '../components/ui/ResolutionPanel'
import { KPICard } from '../components/ui/KPICard'
import { MetricTip } from '../components/ui/InfoTooltip'
import {
  Package, HardHat, Check, X, ShieldCheck, AlertTriangle, FileWarning,
  Banknote, Globe2, ChevronRight, Truck, Gauge, TrendingDown, Users, Clock, Megaphone,
} from 'lucide-react'
import {
  api, fetchSuppliers, fetchLabourAssessment, fetchLabourHistory, fetchSupplierScorecard,
  fetchInboundShipments, fetchWarehouseHealth,
} from '../lib/api'
import {
  ScatterChart, Scatter, LineChart, Line, BarChart, Bar, XAxis, YAxis, ZAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell, LabelList,
} from 'recharts'
import { useTheme } from '../hooks/useTheme'
import { useStore } from '../store/useStore'

// Scenarios whose synthetic engine drives a real workforce story (see backend
// SCENARIO_LABOUR_RANGES) — used to show a "why did this move" banner on the
// Labour Risk tab instead of leaving a number-changed-for-no-reason mystery.
const LABOUR_SCENARIOS = new Set([
  'p1_3pl_closure', 'courier_shortage', 'fuel_crisis', 'beast_from_east', 'cyber_incident', 'p2_stockout', 'heat_pump_surge',
])

const BALLOT_LABELS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' }> = {
  none: { label: 'No industrial action', tone: 'green' },
  notice_served: { label: 'Notice served', tone: 'amber' },
  ballot_open: { label: 'Ballot open', tone: 'amber' },
  action_short_of_strike: { label: 'Action short of strike', tone: 'red' },
  strike_action: { label: 'Strike action', tone: 'red' },
}

const labourRiskColor = (v: number) => v <= 30 ? 'var(--clt-green)' : v <= 60 ? 'var(--clt-amber)' : 'var(--clt-red)'

interface LabourDriver { key: string; label: string; severity: 'red' | 'amber'; icon: React.ElementType }

// Multi-factor labour risk drivers per warehouse — same composite-scoring
// philosophy as supplier risk: absence trend, attrition, contingent-labour
// dependency, overtime strain, union sentiment and industrial-action stage.
function labourRiskDrivers(wh: any): LabourDriver[] {
  const d: LabourDriver[] = []
  if (wh.absenteeism_rate >= 8) d.push({ key: 'abs', label: 'Absenteeism critical', severity: 'red', icon: Users })
  else if (wh.absenteeism_rate >= 5) d.push({ key: 'abs', label: 'Absenteeism elevated', severity: 'amber', icon: Users })
  if (wh.turnover_rate >= 20) d.push({ key: 'trn', label: 'Turnover critical', severity: 'red', icon: TrendingDown })
  else if (wh.turnover_rate >= 16) d.push({ key: 'trn', label: 'Turnover elevated', severity: 'amber', icon: TrendingDown })
  if (wh.agency_staff_pct >= 25) d.push({ key: 'agency', label: 'High agency dependency', severity: 'red', icon: Users })
  else if (wh.agency_staff_pct >= 15) d.push({ key: 'agency', label: 'Agency dependency rising', severity: 'amber', icon: Users })
  if (wh.overtime_pct >= 25) d.push({ key: 'ot', label: 'Overtime strain critical', severity: 'red', icon: Clock })
  else if (wh.overtime_pct >= 18) d.push({ key: 'ot', label: 'Overtime strain rising', severity: 'amber', icon: Clock })
  if (wh.gmb_activity_level !== 'none' || wh.unite_activity_level !== 'none') d.push({ key: 'union', label: 'Union activity', severity: 'amber', icon: Megaphone })
  if (wh.ballot_status && wh.ballot_status !== 'none') {
    const b = BALLOT_LABELS[wh.ballot_status]
    d.push({ key: 'ballot', label: b?.label ?? wh.ballot_status, severity: b?.tone === 'red' ? 'red' : 'amber', icon: FileWarning })
  }
  if (!wh.management_comms_normal) d.push({ key: 'comms', label: 'Comms disrupted', severity: 'amber', icon: FileWarning })
  return d
}

const OTIF_TARGET = 92

// RAG thresholds shared across the page so every visual tells the same story:
// green = at/above target, amber = below target but tolerable, red = critical.
const otifColor = (v: number) => v >= OTIF_TARGET ? 'var(--clt-green)' : v >= 80 ? 'var(--clt-amber)' : 'var(--clt-red)'
const scoreColor = (v: number) => v > 80 ? 'var(--clt-green)' : v > 60 ? 'var(--clt-amber)' : 'var(--clt-red)'

interface RiskDriver {
  key: string
  label: string
  severity: 'red' | 'amber'
  icon: React.ElementType
}

// Multi-factor risk drivers per supplier — best practice is composite,
// multi-source scoring (delivery, compliance, ESG, financial, geopolitical)
// rather than a single OTIF number.
function riskDrivers(s: any): RiskDriver[] {
  const d: RiskDriver[] = []
  if (s.otif_score < 80) d.push({ key: 'otif', label: 'OTIF critical', severity: 'red', icon: TrendingDown })
  else if (s.otif_score < OTIF_TARGET) d.push({ key: 'otif', label: 'OTIF below target', severity: 'amber', icon: TrendingDown })
  if (s.ariba_compliance_status === 'expired') d.push({ key: 'ariba', label: 'Ariba expired', severity: 'red', icon: FileWarning })
  else if (s.ariba_compliance_status === 'expiring_30d') d.push({ key: 'ariba', label: 'Ariba expiring <30d', severity: 'amber', icon: FileWarning })
  if (s.sedex_risk_level === 'high') d.push({ key: 'sedex', label: 'Sedex ESG high', severity: 'red', icon: ShieldCheck })
  else if (s.sedex_risk_level === 'medium') d.push({ key: 'sedex', label: 'Sedex ESG medium', severity: 'amber', icon: ShieldCheck })
  if (s.financial_health_flag) d.push({ key: 'fin', label: 'Financial health', severity: 'red', icon: Banknote })
  if (s.geopolitical_risk_flag) d.push({ key: 'geo', label: 'Geopolitical exposure', severity: 'amber', icon: Globe2 })
  return d
}

const isAtRisk = (s: any) => s.otif_score < 80 || s.composite_risk_score < 60 || s.ariba_compliance_status === 'expired'

function DriverChip({ d }: { d: RiskDriver }) {
  const Icon = d.icon
  return (
    <span className={`badge ${d.severity === 'red' ? 'badge-red' : 'badge-amber'}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <Icon size={11} /> {d.label}
    </span>
  )
}

type SortKey = 'otif' | 'score' | 'name' | 'volume'

export function RiskPage() {
  const { c } = useTheme()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = searchParams.get('tab') === 'labour' ? 'labour' : 'suppliers'
  
  const setActiveTab = (tab: 'suppliers' | 'labour') => {
    setSearchParams({ tab })
  }
  
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [selectedLabourCode, setSelectedLabourCode] = useState<string | null>(null)
  const [atRiskOnly, setAtRiskOnly] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('otif')
  const [sortAsc, setSortAsc] = useState(true) // worst-first by default: exceptions surface at the top

  // Deep-link entry from the Demand & Inventory worklist: a supplier-risk action
  // opens straight onto that supplier's scorecard drawer instead of the bare list.
  useEffect(() => {
    const supplier = searchParams.get('supplier')
    if (!supplier) return
    setSelectedCode(supplier)
    setSearchParams({ tab: 'suppliers' }, { replace: true })
  }, [searchParams, setSearchParams])

  const { data: suppliers } = useQuery({ queryKey: ['suppliers'], queryFn: () => fetchSuppliers() })
  const { data: labour } = useQuery({ queryKey: ['labour'], queryFn: fetchLabourAssessment })
  const { data: inbound } = useQuery({ queryKey: ['inbound-shipments'], queryFn: () => fetchInboundShipments() })
  const { data: warehouseHealth } = useQuery({ queryKey: ['warehouse-health'], queryFn: fetchWarehouseHealth })
  const { data: scenarioMeta } = useQuery({
    queryKey: ['scenario-meta'],
    queryFn: async () => { const r = await api.get('/api/v1/demo/scenarios'); return r.data.data },
    staleTime: Infinity,
  })
  const activeScenario = useStore((s) => s.activeScenario)

  const supplierItems = useMemo<any[]>(() => suppliers?.items ?? [], [suppliers])
  const selected = useMemo(() => supplierItems.find((s) => s.supplier_code === selectedCode) ?? null, [supplierItems, selectedCode])
  const throughputByCode = useMemo(
    () => Object.fromEntries((warehouseHealth ?? []).map((w: any) => [w.code, w])),
    [warehouseHealth]
  )
  const selectedLabour = useMemo(
    () => (labour ?? []).find((w: any) => w.warehouse_code === selectedLabourCode) ?? null,
    [labour, selectedLabourCode]
  )

  // ── Portfolio-level KPIs ──
  const kpis = useMemo(() => {
    if (!supplierItems.length) return null
    const placed = supplierItems.reduce((a, s) => a + (s.orders_placed ?? 0), 0)
    const onTime = supplierItems.reduce((a, s) => a + (s.orders_on_time ?? 0), 0)
    const weightedOtif = placed ? (onTime / placed) * 100 : 0
    const atRisk = supplierItems.filter(isAtRisk).length
    const compliance = supplierItems.filter((s) => s.ariba_compliance_status !== 'compliant' || s.sedex_risk_level === 'high').length
    const avgAbsenteeism = labour?.length ? labour.reduce((a: number, w: any) => a + (w.absenteeism_rate ?? 0), 0) / labour.length : 0
    const avgTurnover = labour?.length ? labour.reduce((a: number, w: any) => a + (w.turnover_rate ?? 0), 0) / labour.length : 0
    const avgAgency = labour?.length ? labour.reduce((a: number, w: any) => a + (w.agency_staff_pct ?? 0), 0) / labour.length : 0
    const industrialActionCount = labour?.filter((w: any) => w.ballot_status && w.ballot_status !== 'none').length ?? 0
    return { weightedOtif, placed, onTime, atRisk, compliance, avgAbsenteeism, avgTurnover, avgAgency, industrialActionCount }
  }, [supplierItems, labour])

  // ── Labour watchlist: warehouses with active risk drivers, worst first ──
  const labourWatchlist = useMemo(() =>
    (labour ?? [])
      .map((w: any) => ({ ...w, drivers: labourRiskDrivers(w) }))
      .filter((w: any) => w.drivers.length > 0)
      .sort((a: any, b: any) => b.risk_score - a.risk_score),
  [labour])

  // ── Watchlist: at-risk suppliers, worst first, with their drivers ──
  const watchlist = useMemo(() =>
    supplierItems
      .map((s) => ({ ...s, drivers: riskDrivers(s) }))
      .filter((s) => s.drivers.length > 0)
      .sort((a, b) => (b.drivers.filter((d: RiskDriver) => d.severity === 'red').length - a.drivers.filter((d: RiskDriver) => d.severity === 'red').length) || a.otif_score - b.otif_score),
  [supplierItems])

  // ── Dependency vs performance matrix (Kraljic-style segmentation) ──
  // X = weekly order volume (dependency / impact proxy), Y = OTIF (performance).
  // Bottom-right = high dependency + poor delivery = the quadrant to act on.
  const matrix = useMemo(() =>
    supplierItems.map((s) => ({
      code: s.supplier_code, name: s.name, volume: s.orders_placed ?? 0,
      otif: s.otif_score, score: s.composite_risk_score, tier1: s.is_tier1,
    })),
  [supplierItems])
  const medianVolume = useMemo(() => {
    const v = matrix.map((m) => m.volume).sort((a, b) => a - b)
    return v.length ? v[Math.floor(v.length / 2)] : 0
  }, [matrix])

  // ── Table rows: filter + sort ──
  const rows = useMemo(() => {
    let r = supplierItems.map((s) => ({ ...s, drivers: riskDrivers(s) }))
    if (atRiskOnly) r = r.filter(isAtRisk)
    const dir = sortAsc ? 1 : -1
    r.sort((a, b) => {
      if (sortKey === 'name') return dir * a.name.localeCompare(b.name)
      if (sortKey === 'score') return dir * (a.composite_risk_score - b.composite_risk_score)
      if (sortKey === 'volume') return dir * ((a.orders_placed ?? 0) - (b.orders_placed ?? 0))
      return dir * (a.otif_score - b.otif_score)
    })
    return r
  }, [supplierItems, atRiskOnly, sortKey, sortAsc])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(true) }
  }
  const sortArrow = (key: SortKey) => sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''

  return (
    <>
      <PageHeader title="Supplier & Labour Risk" subtitle="Supplier scorecards · Portfolio segmentation · Labour risk monitoring" />
      <div className="page-body">
        {/* Portfolio summary — one glance answers "how healthy is my supply base today?" */}
        <div className="kpi-grid section-gap" data-tour="risk-kpis">
          <KPICard
            icon={Gauge} iconColor="#3B82F6"
            label="Network OTIF (volume-weighted)"
            tooltipKey="OTIF Score"
            value={kpis ? kpis.weightedOtif.toFixed(1) : '—'} unit="%"
            target={OTIF_TARGET}
            rag={kpis ? (kpis.weightedOtif >= OTIF_TARGET ? 'G' : kpis.weightedOtif >= 85 ? 'A' : 'R') : undefined}
          />
          <KPICard
            icon={AlertTriangle} iconColor="#EF4444"
            label="Suppliers At Risk"
            tooltipKey="Risk Score"
            value={kpis ? kpis.atRisk : '—'}
            unit={kpis ? `of ${supplierItems.length}` : undefined}
            rag={kpis ? (kpis.atRisk === 0 ? 'G' : kpis.atRisk <= 2 ? 'A' : 'R') : undefined}
          />
          <KPICard
            icon={FileWarning} iconColor="#F59E0B"
            label="Compliance Attention"
            tooltipKey="Ariba Status"
            value={kpis ? kpis.compliance : '—'}
            unit="suppliers"
            rag={kpis ? (kpis.compliance === 0 ? 'G' : kpis.compliance <= 2 ? 'A' : 'R') : undefined}
          />
          <KPICard
            icon={Users} iconColor="#8B5CF6"
            label="Network Absenteeism"
            tooltipKey="Absenteeism Rate"
            value={kpis ? kpis.avgAbsenteeism.toFixed(1) : '—'} unit="%"
            rag={kpis ? (kpis.avgAbsenteeism < 5 ? 'G' : kpis.avgAbsenteeism < 8 ? 'A' : 'R') : undefined}
          />
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
          {(['suppliers', 'labour'] as const).map((tab) => (
            <button
              key={tab}
              data-tour={`risk-tab-${tab}`}
              className={`btn ${activeTab === tab ? 'btn-primary' : 'btn-secondary'} btn-sm`}
              onClick={() => setActiveTab(tab)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {tab === 'suppliers'
                  ? <><Package size={16} /> Suppliers</>
                  : <><HardHat size={16} /> Labour Risk</>}
              </div>
            </button>
          ))}
        </div>

        {activeTab === 'suppliers' && (
          <>
            <div className="grid-2 section-gap">
              {/* Segmentation matrix */}
              <div className="card" data-tour="risk-matrix">
                <div className="card-header">
                  <div>
                    <div className="card-title">Dependency vs Performance Matrix</div>
                    <div className="card-subtitle">Bubble = supplier · X = weekly order volume · Y = OTIF vs {OTIF_TARGET}% target</div>
                  </div>
                </div>
                <div className="card-body">
                  <ResponsiveContainer width="100%" height={280}>
                    <ScatterChart margin={{ top: 14, right: 24, bottom: 6, left: -14 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--clt-grey-100)" />
                      <XAxis type="number" dataKey="volume" name="Weekly orders" tick={{ fontSize: 11 }}
                        domain={['dataMin - 15', 'dataMax + 15']} />
                      <YAxis type="number" dataKey="otif" name="OTIF" unit="%" tick={{ fontSize: 11 }}
                        domain={[55, 100]} />
                      <ZAxis range={[130, 131]} />
                      <ReferenceLine y={OTIF_TARGET} stroke="var(--clt-green)" strokeDasharray="4 4"
                        label={{ value: `Target ${OTIF_TARGET}%`, position: 'insideTopRight', fontSize: 11, fill: 'var(--clt-green)' }} />
                      <ReferenceLine x={medianVolume} stroke="var(--clt-grey-300)" strokeDasharray="4 4" />
                      <Tooltip
                        cursor={{ strokeDasharray: '3 3' }}
                        content={({ payload }) => {
                          const p = payload?.[0]?.payload
                          if (!p) return null
                          return (
                            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 11, boxShadow: 'var(--shadow)' }}>
                              <div style={{ fontWeight: 700, marginBottom: 2 }}>{p.name}</div>
                              <div>OTIF: <b style={{ color: otifColor(p.otif) }}>{p.otif.toFixed(1)}%</b></div>
                              <div>Weekly orders: <b>{p.volume}</b></div>
                              <div>Composite score: <b>{p.score}</b></div>
                            </div>
                          )
                        }}
                      />
                      <Scatter data={matrix} isAnimationActive={false} onClick={(p: any) => setSelectedCode(p?.code ?? p?.payload?.code ?? null)} cursor="pointer">
                        {matrix.map((m) => <Cell key={m.code} fill={otifColor(m.otif)} fillOpacity={0.85} />)}
                        <LabelList dataKey="code" position="top" style={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, flexWrap: 'wrap' }}>
                    <span><b style={{ color: 'var(--clt-red)' }}>Bottom-right</b> = high dependency, poor delivery — act first</span>
                    <span><b style={{ color: 'var(--clt-green)' }}>Top-right</b> = strategic partners</span>
                  </div>
                </div>
              </div>

              {/* Watchlist */}
              <div className="card" data-tour="risk-watchlist">
                <div className="card-header">
                  <div>
                    <div className="card-title">Risk Watchlist</div>
                    <div className="card-subtitle">Suppliers with active risk drivers, worst first</div>
                  </div>
                  <span className={`badge ${watchlist.length ? 'badge-amber' : 'badge-green'}`}>{watchlist.length} flagged</span>
                </div>
                <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflowY: 'auto' }}>
                  {watchlist.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Check size={14} color="var(--clt-green)" /> No suppliers currently flagged.
                    </div>
                  )}
                  {watchlist.map((s) => (
                    <button key={s.supplier_code} onClick={() => setSelectedCode(s.supplier_code)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', width: '100%',
                        background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)', borderRadius: 8,
                        padding: '8px 10px', cursor: 'pointer',
                      }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{s.name}</div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                          {s.drivers.map((d: RiskDriver) => <DriverChip key={d.key} d={d} />)}
                        </div>
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 800, color: otifColor(s.otif_score), whiteSpace: 'nowrap' }}>
                        {s.otif_score.toFixed(1)}%
                      </span>
                      <ChevronRight size={14} color="var(--text-tertiary)" />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Scorecard table */}
            <ActionedToday module="/risk" section="Scorecards" label="supplier action"
              emptyHint="No suppliers watch-listed or reviewed today." />
            <div className="card" data-tour="risk-scorecards">
              <div className="card-header">
                <div className="card-title">Supplier Scorecards</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className={`btn btn-sm ${atRiskOnly ? 'btn-secondary' : 'btn-primary'}`} onClick={() => setAtRiskOnly(false)}>All</button>
                  <button className={`btn btn-sm ${atRiskOnly ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setAtRiskOnly(true)}>At risk</button>
                </div>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('name')}>Supplier{sortArrow('name')}</th>
                    <th>Category</th>
                    <th>Tier</th>
                    <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('otif')}>
                      <MetricTip label="OTIF Score" title="OTIF">OTIF vs target{sortArrow('otif')}</MetricTip>
                    </th>
                    <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('score')}>
                      <MetricTip label="Risk Score">Composite{sortArrow('score')}</MetricTip>
                    </th>
                    <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('volume')}>Orders (wk){sortArrow('volume')}</th>
                    <th>Risk drivers</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s: any) => (
                    <tr key={s.supplier_code} onClick={() => setSelectedCode(s.supplier_code)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{s.name}</div>
                        <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-tertiary)' }}>{s.supplier_code} · {s.country_code}</div>
                      </td>
                      <td><span className="badge badge-grey">{s.category?.replace(/_/g, ' ')}</span></td>
                      <td>{s.is_tier1 ? <span className="badge" style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}>Tier 1</span> : <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Tier 2</span>}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 700, color: otifColor(s.otif_score), minWidth: 46 }}>{s.otif_score?.toFixed(1)}%</span>
                          <span style={{ fontSize: 11, color: s.otif_score >= OTIF_TARGET ? 'var(--clt-green)' : 'var(--clt-red)' }}>
                            {s.otif_score >= OTIF_TARGET ? '+' : ''}{(s.otif_score - OTIF_TARGET).toFixed(1)} pts
                          </span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div className="progress-bar" style={{ width: 60 }}>
                            <div className={`progress-fill ${s.composite_risk_score > 80 ? 'green' : s.composite_risk_score > 60 ? 'amber' : 'red'}`}
                              style={{ width: `${s.composite_risk_score}%` }} />
                          </div>
                          <span style={{ fontSize: 11 }}>{s.composite_risk_score}</span>
                        </div>
                      </td>
                      <td style={{ fontSize: 12 }}>{s.orders_on_time} <span style={{ color: 'var(--text-tertiary)' }}>/ {s.orders_placed}</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {s.drivers.length === 0
                            ? <span style={{ fontSize: 11, color: 'var(--clt-green)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={12} /> Healthy</span>
                            : s.drivers.map((d: RiskDriver) => <DriverChip key={d.key} d={d} />)}
                        </div>
                      </td>
                      <td><ChevronRight size={14} color="var(--text-tertiary)" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {activeTab === 'labour' && (
          <>
            {/* Scenario context — explains why the numbers below moved */}
            {activeScenario && LABOUR_SCENARIOS.has(activeScenario) && (
              <div className="section-gap" style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                background: 'var(--accent-subtle)', border: '1px solid var(--accent-muted)', borderRadius: 10,
              }}>
                <Megaphone size={15} color="#EA580C" />
                <div style={{ fontSize: 12, color: '#9A3412' }}>
                  <b>Scenario active:</b> {scenarioMeta?.[activeScenario]?.name ?? activeScenario} is driving these
                  labour-risk numbers. Reset the scenario in the Simulator to return to baseline.
                </div>
              </div>
            )}

            {/* Labour portfolio KPIs */}
            <div className="kpi-grid section-gap">
              <KPICard
                icon={Users} iconColor="#8B5CF6"
                label="Network Absenteeism" tooltipKey="Absenteeism Rate"
                value={kpis ? kpis.avgAbsenteeism.toFixed(1) : '—'} unit="%"
                rag={kpis ? (kpis.avgAbsenteeism < 5 ? 'G' : kpis.avgAbsenteeism < 8 ? 'A' : 'R') : undefined}
              />
              <KPICard
                icon={TrendingDown} iconColor="#3B82F6"
                label="Network Turnover" tooltipKey="Turnover Rate"
                value={kpis ? kpis.avgTurnover.toFixed(1) : '—'} unit="%"
                rag={kpis ? (kpis.avgTurnover < 16 ? 'G' : kpis.avgTurnover < 20 ? 'A' : 'R') : undefined}
              />
              <KPICard
                icon={HardHat} iconColor="#F59E0B"
                label="Agency Dependency" tooltipKey="Agency Staff %"
                value={kpis ? kpis.avgAgency.toFixed(1) : '—'} unit="%"
                rag={kpis ? (kpis.avgAgency < 15 ? 'G' : kpis.avgAgency < 25 ? 'A' : 'R') : undefined}
              />
              <KPICard
                icon={Megaphone} iconColor="#EF4444"
                label="Sites w/ Industrial Action" tooltipKey="Ballot Status"
                value={kpis ? kpis.industrialActionCount : '—'}
                unit={labour?.length ? `of ${labour.length}` : undefined}
                rag={kpis ? (kpis.industrialActionCount === 0 ? 'G' : 'R') : undefined}
              />
            </div>

            <div className="grid-2 section-gap">
              {/* Risk score by site */}
              <div className="card" data-tour="risk-labour-sites">
                <div className="card-header">
                  <div>
                    <div className="card-title">Labour Risk by Site</div>
                    <div className="card-subtitle">Composite score (0–100, lower is healthier) · dashed lines mark Green/Red bands</div>
                  </div>
                </div>
                <div className="card-body">
                  <ResponsiveContainer width="100%" height={230}>
                    <BarChart data={labour ?? []} margin={{ top: 16, right: 16, bottom: 6, left: -18 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--clt-grey-100)" />
                      <XAxis dataKey="warehouse_code" tick={{ fontSize: 11 }} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                      <ReferenceLine y={30} stroke="var(--clt-green)" strokeDasharray="4 4" />
                      <ReferenceLine y={60} stroke="var(--clt-red)" strokeDasharray="4 4" />
                      <Tooltip
                        cursor={{ fill: 'var(--bg-subtle)' }}
                        content={({ payload }) => {
                          const p = payload?.[0]?.payload
                          if (!p) return null
                          const throughput = throughputByCode[p.warehouse_code]?.throughput_vs_baseline_pct
                          return (
                            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 11, boxShadow: 'var(--shadow)' }}>
                              <div style={{ fontWeight: 700, marginBottom: 2 }}>{p.warehouse_name}</div>
                              <div>Risk score: <b style={{ color: labourRiskColor(p.risk_score) }}>{p.risk_score}</b></div>
                              <div>Absenteeism: <b>{p.absenteeism_rate}%</b> · Turnover: <b>{p.turnover_rate}%</b></div>
                              {throughput != null && <div>Warehouse throughput: <b>{throughput.toFixed(1)}%</b> of baseline</div>}
                            </div>
                          )
                        }}
                      />
                      <Bar dataKey="risk_score" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                        {(labour ?? []).map((w: any) => <Cell key={w.warehouse_code} fill={labourRiskColor(w.risk_score)} fillOpacity={0.85} />)}
                        <LabelList dataKey="risk_score" position="top" style={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Labour watchlist */}
              <div className="card" data-tour="risk-labour-watchlist">
                <div className="card-header">
                  <div>
                    <div className="card-title">Labour Risk Watchlist</div>
                    <div className="card-subtitle">Sites with active risk drivers, worst first</div>
                  </div>
                  <span className={`badge ${labourWatchlist.length ? 'badge-amber' : 'badge-green'}`}>{labourWatchlist.length} flagged</span>
                </div>
                <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto' }}>
                  {labourWatchlist.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Check size={14} color="var(--clt-green)" /> No sites currently flagged.
                    </div>
                  )}
                  {labourWatchlist.map((w: any) => (
                    <button key={w.warehouse_code} onClick={() => setSelectedLabourCode(w.warehouse_code)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', width: '100%',
                        background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)', borderRadius: 8,
                        padding: '8px 10px', cursor: 'pointer',
                      }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{w.warehouse_name}</div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                          {w.drivers.map((d: LabourDriver) => <DriverChip key={d.key} d={d} />)}
                        </div>
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 800, color: labourRiskColor(w.risk_score), whiteSpace: 'nowrap' }}>
                        {w.risk_score}
                      </span>
                      <ChevronRight size={14} color="var(--text-tertiary)" />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Per-warehouse detail cards */}
            <div className="auto-grid" style={{ '--col-min': '400px', '--grid-gap': '16px' } as React.CSSProperties}>
              {(labour || []).map((wh: any) => {
                const abs = wh.absenteeism_rate ?? 0
                const trn = wh.turnover_rate ?? 0
                const absRag: 'G' | 'A' | 'R' = abs >= 8 ? 'R' : abs >= 5 ? 'A' : 'G'
                const trnRag: 'G' | 'A' | 'R' = trn >= 20 ? 'R' : trn >= 16 ? 'A' : 'G'
                const ballot = BALLOT_LABELS[wh.ballot_status] ?? BALLOT_LABELS.none
                const throughput = throughputByCode[wh.warehouse_code]?.throughput_vs_baseline_pct

                const radius = 22
                const circumference = 2 * Math.PI * radius
                const absPercent = Math.min(100, (abs / 10) * 100)
                const offset = circumference - (absPercent / 100) * circumference

                return (
                  <div key={wh.warehouse_code} style={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: 12, padding: 20, position: 'relative', overflow: 'hidden' }}>
                    {/* Subtle top accent bar based on composite risk score */}
                    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: labourRiskColor(wh.risk_score), opacity: 0.7 }} />

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: c.textPrimary, marginBottom: 4 }}>{wh.warehouse_name}</div>
                        <div style={{ fontSize: 12, color: c.textMuted, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Clock size={12} /> Assessed {wh.assessment_date}
                          {throughput != null && <span>· Throughput {throughput.toFixed(0)}% of baseline</span>}
                        </div>
                      </div>
                      <MetricTip label="Composite labour risk score">
                        <div style={{
                          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                          width: 48, height: 48, borderRadius: '50%',
                          border: `2px solid ${labourRiskColor(wh.risk_score)}`, flexShrink: 0,
                        }}>
                          <span style={{ fontSize: 16, fontWeight: 800, color: labourRiskColor(wh.risk_score) }}>{wh.risk_score}</span>
                        </div>
                      </MetricTip>
                    </div>

                    <div style={{ display: 'flex', gap: 32, marginBottom: 18 }}>
                      <MetricTip label="Absenteeism Rate">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          {/* Circular Progress Ring */}
                          <div style={{ position: 'relative', width: 52, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <svg width="52" height="52" style={{ transform: 'rotate(-90deg)' }}>
                              <circle cx="26" cy="26" r={radius} stroke={c.borderSubtle} strokeWidth="4" fill="none" />
                              <circle cx="26" cy="26" r={radius} stroke={c.ragText[absRag]} strokeWidth="4" fill="none" strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
                            </svg>
                            <div style={{ position: 'absolute', fontSize: 12, fontWeight: 700, color: c.textPrimary }}>{abs.toFixed(1)}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, color: c.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Absenteeism</div>
                            <div style={{ fontSize: 12, color: c.ragText[absRag], fontWeight: 600 }}>{absRag === 'R' ? 'Critical' : absRag === 'A' ? 'Elevated' : 'Healthy'}</div>
                          </div>
                        </div>
                      </MetricTip>

                      <div style={{ width: 1, background: c.borderSubtle }} />

                      <MetricTip label="Turnover Rate">
                        <div>
                          <div style={{ fontSize: 11, color: c.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Turnover</div>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                            <span style={{ fontSize: 24, fontWeight: 800, color: c.textPrimary }}>{trn.toFixed(1)}</span>
                            <span style={{ fontSize: 13, color: c.textMuted }}>%</span>
                          </div>
                          <div style={{ fontSize: 12, color: c.ragText[trnRag], fontWeight: 600, marginTop: -2 }}>{trnRag === 'R' ? 'High Risk' : trnRag === 'A' ? 'Warning' : 'Stable'}</div>
                        </div>
                      </MetricTip>
                    </div>

                    {/* Workforce resilience stats */}
                    <div className="auto-grid" style={{ '--col-min': '150px', '--grid-gap': '8px', marginBottom: 14 } as React.CSSProperties}>
                      <MetricTip label="Agency Staff %">
                        <div style={{ background: c.surfaceSubtle, borderRadius: 7, padding: '8px 10px' }}>
                          <div style={{ fontSize: 11, color: c.textMuted }}>Agency dependency</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: c.textPrimary }}>{wh.agency_staff_pct?.toFixed(1)}%</div>
                        </div>
                      </MetricTip>
                      <MetricTip label="Overtime %">
                        <div style={{ background: c.surfaceSubtle, borderRadius: 7, padding: '8px 10px' }}>
                          <div style={{ fontSize: 11, color: c.textMuted }}>Overtime hours</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: c.textPrimary }}>{wh.overtime_pct?.toFixed(1)}%</div>
                        </div>
                      </MetricTip>
                    </div>

                    {/* Threat Intel Tags */}
                    <div style={{ background: c.surfaceSubtle, borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                      <div style={{ fontSize: 11, color: c.textSecondary, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Threat Intel Feed</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <MetricTip label="GMB Activity">
                          <span style={{ background: wh.gmb_activity_level !== 'none' ? c.ragBg.A : c.chipBg, color: wh.gmb_activity_level !== 'none' ? c.ragText.A : c.chipText, border: `1px solid ${wh.gmb_activity_level !== 'none' ? c.ragBorder.A : c.chipBorder}`, padding: '4px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                            GMB: {wh.gmb_activity_level.toUpperCase()}
                          </span>
                        </MetricTip>
                        <MetricTip label="Unite Activity">
                          <span style={{ background: wh.unite_activity_level !== 'none' ? c.ragBg.A : c.chipBg, color: wh.unite_activity_level !== 'none' ? c.ragText.A : c.chipText, border: `1px solid ${wh.unite_activity_level !== 'none' ? c.ragBorder.A : c.chipBorder}`, padding: '4px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                            UNITE: {wh.unite_activity_level.toUpperCase()}
                          </span>
                        </MetricTip>
                        <MetricTip label="News Signals">
                          <span style={{ background: wh.news_signal_count > 0 ? c.ragBg.R : c.chipBg, color: wh.news_signal_count > 0 ? c.ragText.R : c.chipText, border: `1px solid ${wh.news_signal_count > 0 ? c.ragBorder.R : c.chipBorder}`, padding: '4px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                            {wh.news_signal_count} NEWS SIGNALS
                          </span>
                        </MetricTip>
                        <MetricTip label="Industrial Action Stage">
                          <span style={{
                            background: ballot.tone === 'green' ? c.ragBg.G : ballot.tone === 'red' ? c.ragBg.R : c.ragBg.A,
                            color: ballot.tone === 'green' ? c.ragText.G : ballot.tone === 'red' ? c.ragText.R : c.ragText.A,
                            border: `1px solid ${ballot.tone === 'green' ? c.ragBorder.G : ballot.tone === 'red' ? c.ragBorder.R : c.ragBorder.A}`,
                            padding: '4px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4,
                          }}>
                            {ballot.tone === 'green' ? <Check size={11} /> : <Megaphone size={11} />} {ballot.label.toUpperCase()}
                          </span>
                        </MetricTip>
                        {wh.management_comms_normal && (
                          <span style={{ background: c.ragBg.G, color: c.ragText.G, border: `1px solid ${c.ragBorder.G}`, padding: '4px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                            <Check size={12} /> COMMS NORMAL
                          </span>
                        )}
                      </div>
                    </div>

                    <button className="btn btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'center' }}
                      onClick={() => setSelectedLabourCode(wh.warehouse_code)}>
                      View 12-Week Trend
                    </button>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {selected && (
        <SupplierDrawer supplier={selected} inbound={inbound?.items ?? []} onClose={() => setSelectedCode(null)} />
      )}
      {selectedLabour && (
        <LabourDrawer warehouse={selectedLabour} throughput={throughputByCode[selectedLabour.warehouse_code]}
          onClose={() => setSelectedLabourCode(null)} />
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Drill-down drawer: 12-week labour-risk trend and workforce
// resilience detail for one warehouse.
// ─────────────────────────────────────────────────────────────
function LabourDrawer({ warehouse, throughput, onClose }: { warehouse: any; throughput?: any; onClose: () => void }) {
  const { data: history } = useQuery({
    queryKey: ['labour-history', warehouse.warehouse_code],
    queryFn: () => fetchLabourHistory(warehouse.warehouse_code),
    staleTime: 60_000,
  })

  const chartData = useMemo(() => {
    const h = history ?? []
    return [...h].reverse().map((w: any) => ({ ...w, label: w.week_start?.slice(5) }))
  }, [history])

  const drivers = labourRiskDrivers(warehouse)
  const ballot = BALLOT_LABELS[warehouse.ballot_status] ?? BALLOT_LABELS.none

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(5,10,25,0.45)', zIndex: 899 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 470, maxWidth: '92vw', zIndex: 900,
        background: 'var(--bg-card)', borderLeft: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>{warehouse.warehouse_name}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <span className="badge badge-grey" style={{ fontFamily: 'monospace' }}>{warehouse.warehouse_code}</span>
              <span className={`badge badge-${ballot.tone}`}>{ballot.label}</span>
              {throughput?.throughput_vs_baseline_pct != null && (
                <span className="badge badge-grey">{throughput.throughput_vs_baseline_pct.toFixed(0)}% throughput</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="btn btn-secondary btn-sm" title="Close" style={{ padding: '4px 8px' }}><X size={14} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Headline numbers */}
          <div className="auto-grid" style={{ '--col-min': '118px', '--grid-gap': '10px' } as React.CSSProperties}>
            {[
              { label: 'Risk score', value: warehouse.risk_score, color: labourRiskColor(warehouse.risk_score) },
              { label: 'Absenteeism', value: `${warehouse.absenteeism_rate?.toFixed(1)}%`, color: 'var(--text-primary)' },
              { label: 'Turnover', value: `${warehouse.turnover_rate?.toFixed(1)}%`, color: 'var(--text-primary)' },
            ].map((m) => (
              <div key={m.label} style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)' }}>{m.label}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: m.color, marginTop: 2 }}>{m.value}</div>
              </div>
            ))}
          </div>

          {/* 12-week trend */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>12-Week Labour Risk Trend</div>
            {chartData.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Loading history…</div>
            ) : (
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: -22 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--clt-grey-100)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={1} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: any, name: string) => [name === 'risk_score' ? v : `${v}%`, name === 'risk_score' ? 'Risk score' : name === 'absenteeism_rate' ? 'Absenteeism' : 'Turnover']} />
                  <Line type="monotone" dataKey="risk_score" stroke="var(--clt-blue)" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                  <Line type="monotone" dataKey="absenteeism_rate" stroke="var(--clt-amber)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
            <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: 'var(--clt-blue)', marginRight: 4 }} />Risk score</span>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: 'var(--clt-amber)', marginRight: 4 }} />Absenteeism %</span>
            </div>
          </div>

          {/* Workforce resilience detail */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Workforce Resilience</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <ComplianceRow label="Agency staff dependency" badge={`${warehouse.agency_staff_pct?.toFixed(1)}%`}
                tone={warehouse.agency_staff_pct >= 25 ? 'red' : warehouse.agency_staff_pct >= 15 ? 'amber' : 'green'} />
              <ComplianceRow label="Overtime hours" badge={`${warehouse.overtime_pct?.toFixed(1)}%`}
                tone={warehouse.overtime_pct >= 25 ? 'red' : warehouse.overtime_pct >= 18 ? 'amber' : 'green'} />
              <ComplianceRow label="Safety incidents (YTD)" badge={`${warehouse.safety_incidents_ytd}`}
                tone={warehouse.safety_incidents_ytd >= 3 ? 'red' : warehouse.safety_incidents_ytd >= 1 ? 'amber' : 'green'} />
              <ComplianceRow label="Management comms" badge={warehouse.management_comms_normal ? 'normal' : 'disrupted'}
                tone={warehouse.management_comms_normal ? 'green' : 'amber'} />
            </div>
            {drivers.length > 0 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                {drivers.map((d) => <DriverChip key={d.key} d={d} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Drill-down drawer: 12-week OTIF trend, compliance detail, and
// live inbound shipments for one supplier.
// ─────────────────────────────────────────────────────────────
function SupplierDrawer({ supplier, inbound, onClose }: { supplier: any; inbound: any[]; onClose: () => void }) {
  const navigate = useNavigate()
  const { data: scorecard } = useQuery({
    queryKey: ['supplier-scorecard', supplier.supplier_code],
    queryFn: () => fetchSupplierScorecard(supplier.supplier_code),
    staleTime: 60_000,
  })

  const history = useMemo(() => {
    const h = scorecard?.weekly_history ?? []
    // API returns newest first — chart wants chronological.
    return [...h].reverse().map((w: any) => ({ ...w, label: w.week_start?.slice(5) }))
  }, [scorecard])

  const shipments = useMemo(() => inbound.filter((sh) => sh.supplier_code === supplier.supplier_code), [inbound, supplier])
  const drivers = riskDrivers(supplier)

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(5,10,25,0.45)', zIndex: 899 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 470, maxWidth: '92vw', zIndex: 900,
        background: 'var(--bg-card)', borderLeft: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>{supplier.name}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <span className="badge badge-grey" style={{ fontFamily: 'monospace' }}>{supplier.supplier_code}</span>
              <span className="badge badge-grey">{supplier.category?.replace(/_/g, ' ')}</span>
              {supplier.is_tier1 && <span className="badge" style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}>Tier 1</span>}
              <span className="badge badge-grey">{supplier.country_code}</span>
            </div>
          </div>
          <button onClick={onClose} className="btn btn-secondary btn-sm" title="Close" style={{ padding: '4px 8px' }}><X size={14} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Headline numbers */}
          <div className="auto-grid" style={{ '--col-min': '118px', '--grid-gap': '10px' } as React.CSSProperties}>
            {[
              { label: 'OTIF this week', value: `${supplier.otif_score?.toFixed(1)}%`, color: otifColor(supplier.otif_score) },
              { label: 'Composite score', value: supplier.composite_risk_score, color: scoreColor(supplier.composite_risk_score) },
              { label: 'Orders on time', value: `${supplier.orders_on_time}/${supplier.orders_placed}`, color: 'var(--text-primary)' },
            ].map((m) => (
              <div key={m.label} style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)' }}>{m.label}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: m.color, marginTop: 2 }}>{m.value}</div>
              </div>
            ))}
          </div>

          {/* 12-week OTIF trend */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>12-Week OTIF Trend</div>
            {history.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Loading history…</div>
            ) : (
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={history} margin={{ top: 6, right: 8, bottom: 0, left: -22 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--clt-grey-100)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={1} />
                  <YAxis domain={[50, 100]} tick={{ fontSize: 11 }} unit="%" />
                  <Tooltip formatter={(v: any) => [`${Number(v).toFixed(1)}%`, 'OTIF']} />
                  <ReferenceLine y={OTIF_TARGET} stroke="var(--clt-green)" strokeDasharray="4 4"
                    label={{ value: 'Target', position: 'insideTopRight', fontSize: 11, fill: 'var(--clt-green)' }} />
                  <Line type="monotone" dataKey="otif_score" stroke="var(--clt-blue)" strokeWidth={2}
                    dot={{ r: 2 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Compliance & risk drivers */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Compliance & Risk Drivers</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <ComplianceRow label="Ariba compliance"
                badge={supplier.ariba_compliance_status?.replace(/_/g, ' ')}
                tone={supplier.ariba_compliance_status === 'compliant' ? 'green' : supplier.ariba_compliance_status === 'expiring_30d' ? 'amber' : 'red'} />
              <ComplianceRow label="Sedex ESG risk"
                badge={supplier.sedex_risk_level}
                tone={supplier.sedex_risk_level === 'low' ? 'green' : supplier.sedex_risk_level === 'medium' ? 'amber' : 'red'} />
              <ComplianceRow label="Financial health"
                badge={supplier.financial_health_flag ? 'flagged' : 'no concerns'}
                tone={supplier.financial_health_flag ? 'red' : 'green'} />
              <ComplianceRow label="Geopolitical exposure"
                badge={supplier.geopolitical_risk_flag ? `elevated (${supplier.country_code})` : 'low'}
                tone={supplier.geopolitical_risk_flag ? 'amber' : 'green'} />
            </div>
            {drivers.length > 0 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                {drivers.map((d) => <DriverChip key={d.key} d={d} />)}
              </div>
            )}
          </div>

          {/* Inbound shipments */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Truck size={13} /> Inbound Shipments ({shipments.length})
              <button
                onClick={() => navigate(`/demand?supplier=${encodeURIComponent(supplier.supplier_code)}`)}
                title={`Open the purchase orders behind these shipments, filtered to ${supplier.name}`}
                style={{
                  marginLeft: 'auto', fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 6,
                  cursor: 'pointer', background: 'var(--bg-subtle)', color: 'var(--text-secondary)',
                  border: '1px solid var(--border-subtle)', display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
              >
                View purchase orders <ChevronRight size={11} />
              </button>
            </div>
            {shipments.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>No live inbound shipments from this supplier.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {shipments.map((sh) => (
                  <div key={sh.shipment_ref} style={{
                    background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)', borderRadius: 8,
                    padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                        {sh.shipment_ref}
                        {/* Freight is the physical leg of a PO — naming the order it
                            belongs to is what lets this list be reconciled against the
                            PO queue on Demand & Inventory. */}
                        {sh.po_number && (
                          <span
                            title={`Freight against ${sh.po_number}${sh.sku_code ? ` · ${sh.sku_code}` : ''}`}
                            style={{ marginLeft: 6, fontWeight: 600, color: 'var(--text-tertiary)' }}
                          >
                            · {sh.po_number}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{sh.carrier} → {sh.destination_warehouse} · {sh.total_units} units</div>
                    </div>
                    {sh.delay_hours > 0 && (
                      <span className="badge badge-red">+{Math.round(sh.delay_hours)}h late</span>
                    )}
                    <span className={`badge ${sh.status === 'delayed' ? 'badge-red' : sh.status === 'in_transit' ? 'badge-green' : 'badge-amber'}`}>
                      {sh.status?.replace(/_/g, ' ')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function ComplianceRow({ label, badge, tone }: { label: string; badge: string; tone: 'green' | 'amber' | 'red' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '7px 10px' }}>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label}</span>
      <span className={`badge badge-${tone}`}>{badge}</span>
    </div>
  )
}
