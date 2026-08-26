import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '../components/ui/PageHeader'
import { ActionedToday } from '../components/ui/ResolutionPanel'
import { KPICard } from '../components/ui/KPICard'
import { fetchSustainabilityDashboard, api } from '../lib/api'
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, LineChart, Line } from 'recharts'
import { Leaf, Wrench, PackagePlus, CloudSun, Wind, ShieldCheck, CheckCircle, Timer } from 'lucide-react'

const EMISSION_COLORS = ['#3B82F6', '#8B5CF6', '#F97316', '#10B981', '#F59E0B']

export function SustainabilityPage() {
  const { data: sustainability } = useQuery({ queryKey: ['sustainability'], queryFn: fetchSustainabilityDashboard })
  const { data: scope3 } = useQuery({
    queryKey: ['scope3'],
    queryFn: async () => { const r = await api.get('/api/v1/reverse/scope3-emissions'); return r.data.data },
  })
  const { data: hts } = useQuery({
    queryKey: ['hts'],
    queryFn: async () => { const r = await api.get('/api/v1/reverse/hts-batches'); return r.data.data },
  })
  const { data: pipeline } = useQuery({
    queryKey: ['reverse-pipeline'],
    queryFn: async () => { const r = await api.get('/api/v1/reverse/pipeline'); return r.data.data },
  })

  const { scope3Data, monthlyData, scope3Total } = useMemo(() => {
    const sd = scope3?.by_category ?? []
    return {
      scope3Data: sd,
      monthlyData: [...(scope3?.monthly_trend ?? [])].reverse(),
      scope3Total: sd.reduce((s: number, d: any) => s + Number(d.tco2e), 0),
    }
  }, [scope3])

  return (
    <>
      <PageHeader title="Sustainability & Reverse Logistics" subtitle="People & Planet Plan · Circular Economy · Scope 3" />
      <div className="page-body">
        {/* Headline KPIs */}
        {sustainability && (
          <div className="kpi-grid section-gap" data-tour="sus-kpis">
            <KPICard
              icon={Leaf} iconColor="#10B981"
              label="Landfill Diversion"
              value={sustainability.landfill_diversion_pct?.toFixed(1)}
              unit="%"
              target={sustainability.landfill_diversion_target}
              rag={sustainability.landfill_diversion_pct >= sustainability.landfill_diversion_target ? 'G' : 'A'}
            />
            <KPICard
              icon={Wrench} iconColor="#3B82F6"
              label="Reconditioning Yield"
              value={sustainability.reconditioning_yield_pct?.toFixed(1)}
              unit="%"
            />
            <KPICard
              icon={PackagePlus} iconColor="#8B5CF6"
              label="Parts Reconditioned in Use"
              value={sustainability.reconditioned_parts_in_use ?? '—'}
            />
            <KPICard
              icon={Wind} iconColor="#059669"
              label="CO₂ Saved YTD"
              value={(sustainability.co2_saved_kg_ytd / 1000)?.toFixed(0)}
              unit="tCO₂e"
            />
            <KPICard
              icon={CloudSun}
              label="Scope 3 Emissions YTD"
              value={sustainability.scope3_total_tco2e_ytd?.toFixed(0)}
              unit="tCO₂e"
              target={sustainability.scope3_target_tco2e_fy}
              rag={sustainability.scope3_total_tco2e_ytd <= sustainability.scope3_target_tco2e_fy ? 'G' : 'A'}
            />
            <KPICard
              icon={ShieldCheck} iconColor="#0EA5E9"
              label="WEEE Compliance"
              value={sustainability.weee_compliance_pct?.toFixed(1)}
              unit="%"
            />
          </div>
        )}

        <div className="grid-2 section-gap">
          {/* Scope 3 breakdown */}
          <div className="card" data-tour="sus-scope3">
            <div className="card-header"><div className="card-title">Scope 3 Emissions by Category</div></div>
            <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{ flex: '0 0 190px' }}>
                <ResponsiveContainer width="100%" height={190}>
                  <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                    <Pie data={scope3Data} cx="50%" cy="50%" innerRadius={48} outerRadius={80}
                      dataKey="tco2e" nameKey="category" isAnimationActive={false}>
                      {scope3Data.map((_: any, i: number) => <Cell key={i} fill={EMISSION_COLORS[i % EMISSION_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v: any) => [`${Number(v).toFixed(1)} tCO₂e`, 'Emissions']} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 9 }}>
                {scope3Data.map((entry: any, i: number) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: EMISSION_COLORS[i % EMISSION_COLORS.length], flexShrink: 0 }} />
                    <span style={{ fontSize: 12, textTransform: 'capitalize', color: 'var(--text-primary)', flex: 1 }}>
                      {String(entry.category).replace(/_/g, ' ')}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {scope3Total ? `${((Number(entry.tco2e) / scope3Total) * 100).toFixed(0)}%` : ''}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', minWidth: 36, textAlign: 'right' }}>
                      {Number(entry.tco2e).toFixed(0)} t
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Monthly trend */}
          <div className="card" data-tour="sus-trend">
            <div className="card-header"><div className="card-title">Scope 3 Monthly Trend</div></div>
            <div className="card-body">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={monthlyData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--clt-grey-100)" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={48} />
                  <Tooltip formatter={(v: any) => [`${Number(v).toFixed(0)} tCO₂e`, 'Emissions']} />
                  <Line type="monotone" dataKey="total_tco2e" stroke="var(--clt-blue)" strokeWidth={2} dot={{ r: 3 }} name="tCO₂e" isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Reverse logistics pipeline */}
        {pipeline?.stages && (
          <div className="card section-gap" data-tour="sus-reverse">
            <ActionedToday module="/sustainability" section="Reverse Pipeline" label="collection sweep"
              emptyHint="No collection sweeps scheduled today." />
            <div className="card-header"><div className="card-title">Reverse Logistics Pipeline</div><div className="card-subtitle">Decommissioned → Reconditioned</div></div>
            <div className="card-body">
              <div style={{ display: 'flex', gap: 0, alignItems: 'stretch' }}>
                {pipeline.stages.map((stage: any, i: number) => (
                  <div key={i} style={{ flex: 1, textAlign: 'center', position: 'relative' }}>
                    <div style={{
                      background: `hsl(${220 + i * 20}, 70%, ${65 - i * 5}%)`,
                      color: '#fff', borderRadius: i === 0 ? '8px 0 0 8px' : i === pipeline.stages.length - 1 ? '0 8px 8px 0' : 0,
                      padding: '14px 8px',
                    }}>
                      <div style={{ fontSize: 22, fontWeight: 800 }}>{stage.count}</div>
                      <div style={{ fontSize: 11, opacity: 0.9, marginTop: 2 }}>{stage.stage}</div>
                      {stage.value_gbp > 0 && (
                        <div style={{ fontSize: 11, marginTop: 4, background: 'rgba(0,0,0,0.15)', borderRadius: 4, padding: '2px 4px' }}>
                          £{(stage.value_gbp / 1000).toFixed(0)}k
                        </div>
                      )}
                    </div>
                    {i < pipeline.stages.length - 1 && (
                      <div style={{ position: 'absolute', right: -8, top: '50%', transform: 'translateY(-50%)', zIndex: 1, color: 'var(--clt-grey-400)', fontSize: 16 }}>›</div>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 11, color: 'var(--clt-grey-500)' }}>
                <span>WEEE Compliant: {(pipeline.weee_compliant_pct * 1).toFixed(1)}%</span>
                <span>COSHH Compliant: {(pipeline.coshh_compliant_pct * 1).toFixed(1)}%</span>
                <span>Month: {pipeline.month}</span>
              </div>
            </div>
          </div>
        )}

        {/* HTS Batches */}
        {hts && hts.length > 0 && (
          <div className="card" data-tour="sus-batches">
            <div className="card-header">
              <div className="card-title">HTS Reconditioning Batches</div>
              <div className="card-subtitle">BSI Kitemark certified reconditioning</div>
            </div>
            <table className="data-table">
              <thead>
                <tr><th>Batch Ref</th><th>Component</th><th>Submitted</th><th>Reconditioned</th><th>Scrapped</th><th>Yield</th><th>BSI</th><th>Status</th></tr>
              </thead>
              <tbody>
                {hts.map((b: any) => (
                  <tr key={b.batch_ref}>
                    <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{b.batch_ref}</td>
                    <td style={{ textTransform: 'capitalize' }}>{b.component_type.replace(/_/g, ' ')}</td>
                    <td>{b.units_submitted}</td>
                    <td style={{ color: 'var(--clt-green)', fontWeight: 600 }}>{b.units_reconditioned}</td>
                    <td style={{ color: 'var(--clt-grey-500)' }}>{b.units_scrapped}</td>
                    <td>
                      <span style={{ fontWeight: 700, color: b.yield_pct >= 75 ? 'var(--clt-green)' : 'var(--clt-amber)' }}>
                        {b.yield_pct?.toFixed(1)}%
                      </span>
                    </td>
                    <td>{b.bsi_kitemark_certified ? <CheckCircle size={14} color="#10B981" /> : <Timer size={14} color="#F59E0B" />}</td>
                    <td><span className={`badge ${b.status === 'completed' ? 'badge-green' : b.status === 'qc' ? 'badge-amber' : 'badge-blue'}`}>{b.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
