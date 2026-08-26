import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, RotateCcw, Eye } from 'lucide-react'
import { PageHeader } from '../components/ui/PageHeader'
import { api } from '../lib/api'
import { useStore } from '../store/useStore'
import { useTheme } from '../hooks/useTheme'

const STATUS_DEFINITIONS = [
  {
    label: 'Healthy', color: '#10B981', bg: '#ECFDF5', border: '#6EE7B7',
    definition: 'All KPIs above target. No open P1/P2 exceptions. Inventory above safety stock. Warehouse throughput ≥85% baseline. Supplier OTIF ≥92%.',
  },
  {
    label: 'At Risk', color: '#F59E0B', bg: '#FFFBEB', border: 'var(--status-warning-border)',
    definition: 'One or more KPIs amber. Open P3 or P2 exceptions. Inventory approaching safety stock. Warehouse throughput 60–84%. Trending toward critical if unaddressed.',
  },
  {
    label: 'Critical', color: '#EF4444', bg: '#FEF2F2', border: 'var(--status-danger-border)',
    definition: 'Multiple KPIs red. Active P1 exception. One or more stockouts. Primary warehouse below 40% throughput. Immediate incident response required.',
  },
]

const SCENARIOS = [
  {
    group: 'Routine Operational Risks (P3/P4)',
    blurb: 'Low-severity friction a control tower absorbs on a normal week. Simulate one to practise containment before it compounds.',
    items: [
      { id: 'locker_outage', emoji: '🔐', name: 'ByBox Locker Outage', desc: '~40 North West lockers offline after a comms fault — pre-8AM confirmation lost, master-key fallback in force.' },
      { id: 'courier_shortage', emoji: '🚚', name: 'Agency Courier No-Show', desc: 'Overnight courier crew fails to report at Manchester — courier OT drops to ~75%, three trunk moves slip 2–5h.' },
      { id: 'supplier_otif_dip', emoji: '📉', name: 'Supplier OTIF Dip', desc: 'Samsung HA OTIF slips to 78% for a second week — watch-list risk, no supply gap yet.' },
    ],
  },
  {
    group: 'Major Risk Events',
    blurb: 'High-impact scenarios that stress multiple modules at once. Simulate one, then open the exception it raises (or the Executive Dashboard) to see its AI risk plan.',
    items: [
      { id: 'p1_3pl_closure', emoji: '🏭', name: 'P1: 3PL Site Closure', desc: 'TVS SCS Leicester drops to 15% throughput — Coventry failover triggered, FTFR falls to 61%, high regional traffic.' },
      { id: 'p2_stockout', emoji: '📦', name: 'P2: Critical Stockout', desc: 'Diverter valves at zero stock across all hubs — emergency PO raised, FTFR 64%.' },
      { id: 'beast_from_east', emoji: '❄️', name: 'Beast from East', desc: 'Extreme cold: demand ×1.42, fault signals +45%, severe traffic, 8 vans weather-damaged, EV range −30%.' },
      { id: 'supplier_insolvency', emoji: '⚡', name: 'Supplier Insolvency', desc: 'Mitsubishi HVAC financial risk flag — heat pumps suspended, contingency POs issued.' },
      { id: 'heat_pump_surge', emoji: '🔥', name: 'Heat Pump Install Surge', desc: 'Govt grant: CPQ pipeline ×8.1, HP inventory critical (3 units), urgent HGV shipments.' },
      { id: 'port_congestion', emoji: '🚢', name: 'Port Congestion', desc: 'Felixstowe berth congestion: all sea freight delayed 5–9 days, lead times ×1.6, DoS eroding on imported SKUs.' },
      { id: 'cyber_incident', emoji: '🔒', name: 'Cyber Incident at 3PL', desc: 'Ransomware takes Leicester WMS offline — 31% throughput on manual picking, locker telemetry lost, P1 raised.' },
      { id: 'fuel_crisis', emoji: '⛽', name: 'National Fuel Crisis', desc: 'Forecourt shortages ground 14 diesel vans, fuel-priority routing for 90 engineers, EVs take emergency jobs.' },
    ],
  },
]


// Scenario "affected modules" → the page where that impact is visible.
const MODULE_ROUTE: Record<string, string> = {
  'Demand & Inventory': '/demand',
  '3PL & Supplier Risk': '/risk',
  'Labour Risk': '/risk',
  'Exceptions': '/exceptions',
  'Transport Control': '/transport',
  'Live Field Ops': '/visibility',
  'IoT & Smart Tech': '/iot',
  'Analytics': '/',
  'All': '/',
}

export function SimulatorPage({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate()
  const { c } = useTheme()
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const activeScenario = useStore(s => s.activeScenario)
  const setActiveScenario = useStore(s => s.setActiveScenario)
  const setP1Exceptions = useStore(s => s.setP1Exceptions)
  const queryClient = useQueryClient()

  const { data: meta } = useQuery({
    queryKey: ['scenario-meta'],
    queryFn: async () => { const r = await api.get('/api/v1/demo/scenarios'); return r.data.data },
    staleTime: Infinity,
  })

  async function runScenario(id: string) {
    setLoading(id)
    setError(null)
    try {
      await api.post('/api/v1/demo/scenario', { scenario_id: id })
      setActiveScenario(id === 'normal' ? null : id)
      // Always re-sync from live state rather than assuming per scenario —
      // the scenario's own handler decides whether any P1 ends up open.
      // Run this alongside the full refetch (not after it) — they're
      // independent, and every extra sequential round-trip here is time the
      // whole app sits showing stale metrics.
      const [snapshot] = await Promise.all([
        api.get('/api/v1/exceptions?priority=P1&status=open'),
        // Refetch everything, including inactive pages, so every module reflects the scenario
        queryClient.invalidateQueries({ refetchType: 'all' }),
      ])
      const p1s = (snapshot.data?.data?.items ?? []) as any[]
      setP1Exceptions(p1s)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(err?.response?.data?.detail ?? err?.message ?? 'Scenario failed')
    } finally {
      setLoading(null)
    }
  }

  const body = (
      <div className={embedded ? '' : 'page-body'}>

        {/* Status definitions */}
        <div className="grid-3 section-gap" data-tour="sim-health">
          {STATUS_DEFINITIONS.map(({ label, color, bg, border, definition }) => (
            <div key={label} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: '12px 14px' }}>
              <span style={{ fontSize: 11, fontWeight: 800, color, border: `1px solid ${border}`, borderRadius: 5, padding: '2px 8px', background: 'var(--bg-card)' }}>{label}</span>
              <div style={{ fontSize: 11, color: '#374151', lineHeight: 1.55, marginTop: 8 }}>{definition}</div>
            </div>
          ))}
        </div>

        {/* Baseline note + reset (always available) */}
        {!activeScenario && (
          <div className="section-gap" data-tour="sim-state" style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
            background: c.surfaceSubtle, border: `1px solid ${c.border}`, borderRadius: 10,
          }}>
            <Eye size={15} color={c.textSecondary} />
            <div style={{ flex: 1, fontSize: 12, color: c.textSecondary }}>
              <b>Baseline state active</b> — a usual control-tower day: mostly green KPIs with routine amber drift,
              a handful of open P2/P3 exceptions, and warehouses ticking between 76–102% of baseline.
            </div>
            <button
              onClick={() => runScenario('normal')}
              disabled={loading !== null}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700,
                padding: '6px 12px', borderRadius: 6, border: `1px solid ${c.border}`,
                background: c.surface, color: c.textSecondary, cursor: 'pointer',
              }}
            >
              <RotateCcw size={12} /> Regenerate baseline
            </button>
          </div>
        )}

        {/* Active scenario banner */}
        {activeScenario && (
          <div className="section-gap" data-tour="sim-state" style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
            background: 'var(--accent-subtle)', border: '1px solid var(--accent-muted)', borderRadius: 10,
          }}>
            <Eye size={15} color="#EA580C" />
            <div style={{ flex: 1, fontSize: 12, color: '#9A3412' }}>
              <b>Scenario active:</b> {meta?.[activeScenario]?.name ?? activeScenario} — all modules are showing its impact.
              Affected: {(meta?.[activeScenario]?.affected_modules ?? []).join(', ')}
            </div>
            <button
              onClick={() => runScenario('normal')}
              disabled={loading !== null}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700,
                padding: '6px 12px', borderRadius: 6, border: '1px solid var(--accent-muted)',
                background: 'var(--bg-card)', color: 'var(--accent-text)', cursor: 'pointer',
              }}
            >
              <RotateCcw size={12} /> Reset to Normal
            </button>
          </div>
        )}

        {error && (
          <div className="section-gap" style={{ background: 'var(--status-danger-bg)', color: 'var(--status-danger-text)', padding: '10px 14px', fontSize: 12, borderRadius: 8 }}>
            {error}
          </div>
        )}

        {/* Scenario groups */}
        {SCENARIOS.map((group, gi) => (
          <div key={group.group} className="section-gap" data-tour={gi === 0 ? 'sim-routine' : 'sim-major'}>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: c.textPrimary }}>{group.group}</div>
              <div style={{ fontSize: 11, color: c.textSecondary, marginTop: 2 }}>{group.blurb}</div>
            </div>
            <div className="auto-grid" style={{ '--col-min': '340px', '--grid-gap': '12px' } as React.CSSProperties}>
              {group.items.map(s => {
                const m = meta?.[s.id]
                const isActive = activeScenario === s.id
                const isLoading = loading === s.id
                return (
                  <div key={s.id} style={{
                    background: c.surface, borderRadius: 10,
                    border: `1px solid ${isActive ? '#FDBA74' : c.border}`,
                    boxShadow: isActive ? '0 0 0 2px #FDBA7440' : 'var(--shadow-sm)',
                    display: 'flex', flexDirection: 'column',
                  }}>
                    <div style={{ padding: '13px 15px', flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                        <span style={{ fontSize: 17 }}>{s.emoji}</span>
                        <span style={{ fontSize: 13, fontWeight: 800, color: c.textPrimary, flex: 1 }}>{s.name}</span>
                        {isActive && (
                          <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', background: 'var(--accent-subtle)', color: 'var(--accent-text)', border: '1px solid var(--accent-muted)', borderRadius: 4, padding: '2px 7px' }}>
                            Active
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: c.textSecondary, lineHeight: 1.55 }}>{s.desc}</div>
                      {m?.affected_modules && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 9 }}>
                          {m.affected_modules.map((mod: string) => {
                            const route = MODULE_ROUTE[mod]
                            return (
                              <button
                                key={mod}
                                disabled={!route}
                                onClick={(e) => { e.stopPropagation(); if (route) navigate(route) }}
                                title={route ? `Open ${mod} to see the impact` : undefined}
                                style={{
                                  fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                                  background: c.surfaceSubtle, border: `1px solid ${c.border}`, color: c.textSecondary,
                                  cursor: route ? 'pointer' : 'default',
                                }}
                              >
                                {mod}{route ? ' ↗' : ''}
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    {/* actions */}
                    <div style={{ display: 'flex', gap: 8, padding: '0 15px 13px' }}>
                      <button
                        onClick={() => runScenario(s.id)}
                        disabled={loading !== null}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700,
                          padding: '6px 13px', borderRadius: 6, border: 'none', cursor: 'pointer',
                          background: s.id === 'normal' ? '#10B981' : 'var(--clt-blue)', color: '#fff',
                          opacity: loading !== null && !isLoading ? 0.5 : 1,
                        }}
                      >
                        <Play size={11} /> {isLoading ? 'Applying…' : s.id === 'normal' ? 'Reset' : 'Simulate'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
  )

  if (embedded) return body
  return (
    <>
      <PageHeader
        title="Scenario Simulator"
        subtitle="Simulate risk events · watch them propagate across modules · plan the response with AI"
      />
      {body}
    </>
  )
}
