import { useState } from 'react'
import { useStore } from '../../store/useStore'
import { api } from '../../lib/api'
import { useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2, AlertCircle, XCircle,
  Factory, Package, CloudSnow, Zap, Flame,
  Play, Loader2, Clapperboard,
} from 'lucide-react'

const STATUS_DEFINITIONS = [
  {
    label: 'Healthy',
    color: '#10B981',
    bg: '#ECFDF5',
    border: '#6EE7B7',
    definition: 'All KPIs above target. No open P1/P2 exceptions. Inventory above safety stock. Warehouse throughput ≥85% baseline. Supplier OTIF ≥92%.',
  },
  {
    label: 'At Risk',
    color: '#F59E0B',
    bg: '#FFFBEB',
    border: 'var(--status-warning-border)',
    definition: 'One or more KPIs amber (below target). Open P3 or P2 exceptions. Inventory approaching safety stock. Warehouse throughput 60–84%. Trending toward critical if unaddressed.',
  },
  {
    label: 'Critical',
    color: '#EF4444',
    bg: '#FEF2F2',
    border: 'var(--status-danger-border)',
    definition: 'Multiple KPIs red. Active P1 exception. One or more stockouts. Primary warehouse below 40% throughput. Playbook activation required immediately.',
  },
]

// Icon chip: small lucide icon on a soft coloured background — IMSERV style
function ScenarioIcon({ icon: Icon, color, bg }: { icon: React.ElementType; color: string; bg: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 26, height: 26, borderRadius: 7, flexShrink: 0,
      background: bg, border: `1px solid ${color}33`,
    }}>
      <Icon size={13} strokeWidth={1.9} color={color} />
    </span>
  )
}

const SCENARIOS = [
  {
    group: 'System Health States',
    items: [
      {
        id: 'normal',
        icon: CheckCircle2, iconColor: '#10B981', iconBg: '#ECFDF5',
        name: 'Healthy',
        desc: 'All KPIs green, no open exceptions, full inventory, warehouses at baseline. Reset to this state at any time.',
      },
      {
        id: 'at_risk',
        icon: AlertCircle, iconColor: '#F59E0B', iconBg: '#FFFBEB',
        name: 'At Risk',
        desc: 'KPIs amber, 3 open exceptions (P2 + 2×P3), 5 SKUs in reorder window (BLR-001, HP-001, HP-002, BLR-004, EV-001), warehouse throughput 66–73%, 80 van alerts.',
      },
      {
        id: 'critical',
        icon: XCircle, iconColor: '#EF4444', iconBg: '#FEF2F2',
        name: 'Critical',
        desc: 'P1 active (Leicester NDC at 23%), P2 stockout (BLR-001 zero stock), 5 open exceptions, 380 van alerts, all KPIs red. Playbook A auto-activated.',
      },
    ],
  },
  {
    group: 'Specific Incidents',
    items: [
      {
        id: 'p1_3pl_closure',
        icon: Factory, iconColor: '#7C3AED', iconBg: '#EDE9FE',
        name: 'P1: 3PL Site Closure',
        desc: 'TVS SCS Leicester drops to 15% throughput – Playbook A activated, FTFR falls to 61%',
      },
      {
        id: 'p2_stockout',
        icon: Package, iconColor: '#DC2626', iconBg: '#FEF2F2',
        name: 'P2: Critical Stockout',
        desc: 'Diverter valves at zero stock across all hubs – emergency PO raised, FTFR 64%',
      },
      {
        id: 'beast_from_east',
        icon: CloudSnow, iconColor: '#2563EB', iconBg: '#EFF6FF',
        name: 'Beast from East',
        desc: 'Extreme cold: demand ×1.42, boiler signals +45%, inventory days-of-supply halved',
      },
      {
        id: 'supplier_insolvency',
        icon: Zap, iconColor: '#D97706', iconBg: '#FFFBEB',
        name: 'Supplier Insolvency',
        desc: 'Mitsubishi HVAC financial risk flag raised – heat pumps suspended, contingency POs issued',
      },
      {
        id: 'heat_pump_surge',
        icon: Flame, iconColor: '#EA580C', iconBg: '#FFF7ED',
        name: 'Heat Pump Install Surge',
        desc: 'Govt grant: CPQ pipeline ×8.1, HP inventory critical (3 units), urgent HGV shipments',
      },
    ],
  },
]

export function DemoPanel() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const setActiveScenario = useStore(s => s.setActiveScenario)
  const setP1Exceptions   = useStore(s => s.setP1Exceptions)
  const queryClient = useQueryClient()

  async function runScenario(id: string) {
    setLoading(id)
    setError(null)
    setOpen(false)

    try {
      await api.post('/api/v1/demo/scenario', { scenario_id: id })

      setActiveScenario(id)

      // Fetch any P1 exceptions alongside the full refetch (not after it) —
      // they're independent, and every extra sequential round-trip here is
      // time the whole app sits showing stale metrics.
      const needsP1Check = id !== 'normal' && id !== 'at_risk'
      const [snapshot] = await Promise.all([
        needsP1Check ? api.get('/api/v1/exceptions?priority=P1&status=open') : Promise.resolve(null),
        // Invalidate all cached queries (refetchType: 'all' also clears inactive pages)
        queryClient.invalidateQueries({ refetchType: 'all' }),
      ])

      // Reflect the live P1 set in the global banner immediately.
      // Assigned unconditionally: the previous `if (p1s.length > 0)` guard meant a
      // scenario that CLEARED every P1 left the old list in the store, so the
      // banner kept naming exceptions that no longer existed until a WS p1_active
      // or the 120s poll in AppShell corrected it.
      if (!needsP1Check) {
        setP1Exceptions([])
      } else {
        setP1Exceptions((snapshot?.data?.data?.items ?? []) as any[])
      }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(err?.response?.data?.detail ?? err?.message ?? 'Scenario failed')
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="demo-panel">
      {open && (
        <div className="demo-popover">
          <div className="demo-popover-header">
            <Clapperboard size={14} strokeWidth={1.9} style={{ flexShrink: 0 }} />
            Demo Scenario Launcher
          </div>

          <div className="demo-popover-body">
            {/* Status definitions */}
            <div style={{ padding: '10px 12px 6px', borderBottom: '1px solid var(--clt-grey-100)' }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--clt-grey-400)', marginBottom: 7 }}>
                Status Definitions
              </div>
              {STATUS_DEFINITIONS.map(({ label, color, bg, border, definition }) => (
                <div key={label} style={{ display: 'flex', gap: 8, marginBottom: 6, padding: '6px 8px', background: bg, borderRadius: 6, border: `1px solid ${border}` }}>
                  <div style={{ flexShrink: 0, marginTop: 1 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color, background: bg, border: `1px solid ${border}`, borderRadius: 4, padding: '1px 6px' }}>{label}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#374151', lineHeight: 1.45 }}>{definition}</div>
                </div>
              ))}
            </div>

            {error && <div className="demo-error">{error}</div>}

            {/* Grouped scenarios */}
            <div className="scenario-list">
              {SCENARIOS.map((group) => (
                <div key={group.group}>
                  <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--clt-grey-400)', padding: '8px 12px 4px' }}>
                    {group.group}
                  </div>
                  {group.items.map((s) => (
                    <button
                      key={s.id}
                      className={`scenario-btn${loading === s.id ? ' scenario-btn--loading' : ''}`}
                      onClick={() => runScenario(s.id)}
                      disabled={loading !== null}
                    >
                      <div className="scenario-name" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <ScenarioIcon icon={s.icon} color={s.iconColor} bg={s.iconBg} />
                        {s.name}
                      </div>
                      <div className="scenario-desc">{s.desc}</div>
                      {loading === s.id && <div className="scenario-spinner">Applying…</div>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <button
        className={`demo-toggle${loading !== null ? ' demo-toggle--loading' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Demo Scenarios"
      >
        {loading !== null
          ? <Loader2 size={15} strokeWidth={2} style={{ animation: 'spin 0.9s linear infinite' }} />
          : <Play size={15} strokeWidth={2} fill="currentColor" />}
      </button>
    </div>
  )
}
