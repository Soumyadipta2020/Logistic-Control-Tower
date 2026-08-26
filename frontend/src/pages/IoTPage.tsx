import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '../components/ui/PageHeader'
import { ActionedToday } from '../components/ui/ResolutionPanel'
import { KPICard } from '../components/ui/KPICard'
import {
  fetchBoilerFaultPipeline, fetchIoTEstateHealth, fetchSmartMeterStatus,
  fetchPredictiveReplacements,
  type BoilerFaultSignal, type PartsCover,
} from '../lib/api'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import {
  AlertTriangle, PackageSearch, MessageSquareWarning, Zap, Radio, PackageX,
} from 'lucide-react'

const FAULT_COLORS = ['#EF4444', '#F97316', '#F59E0B', '#3B82F6', '#8B5CF6']

/**
 * How each cover state reads in the table. The label is deliberately about the
 * job rather than the warehouse — "on the van" is what decides whether the
 * engineer fixes it today, which is the only question this page is asking.
 */
const COVER_META: Record<PartsCover, { label: string; badge: string }> = {
  on_van: { label: 'On van', badge: 'badge-green' },
  at_ndc: { label: 'NDC — transfer', badge: 'badge-amber' },
  none: { label: 'No cover', badge: 'badge-red' },
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`)
const title = (s: string | null | undefined) => (s ?? '').replace(/_/g, ' ')

export function IoTPage() {
  const { data: faults } = useQuery({ queryKey: ['boiler-faults'], queryFn: fetchBoilerFaultPipeline })
  const { data: estate } = useQuery({ queryKey: ['iot-estate'], queryFn: fetchIoTEstateHealth })
  const { data: smartMeter } = useQuery({ queryKey: ['smart-meter'], queryFn: fetchSmartMeterStatus })
  const { data: predictive } = useQuery({ queryKey: ['predictive'], queryFn: fetchPredictiveReplacements })

  const faultList = useMemo<BoilerFaultSignal[]>(() => faults ?? [], [faults])

  const { pieData, pieTotal, blocked } = useMemo(() => {
    const faultTypes = faultList.reduce((acc: Record<string, number>, f) => {
      acc[f.fault_type] = (acc[f.fault_type] || 0) + 1
      return acc
    }, {})
    const pd = Object.entries(faultTypes).map(([name, value]) => ({ name: title(name), value }))
    return {
      pieData: pd,
      pieTotal: pd.reduce((s, d) => s + d.value, 0),
      blocked: faultList.filter(f => f.pre_positioning_blocked),
    }
  }, [faultList])

  // Parts cover is the one number on this page with a real target: anything below
  // 100% is a predicted job we already know we cannot fix first time.
  const coverRag = estate?.parts_cover_pct == null ? undefined
    : estate.parts_cover_pct >= 100 ? 'G' : estate.parts_cover_pct >= 90 ? 'A' : 'R'
  const telemetryRag = estate?.van_telemetry_health_pct == null ? undefined
    : estate.van_telemetry_health_pct >= 95 ? 'G' : estate.van_telemetry_health_pct >= 85 ? 'A' : 'R'

  return (
    <>
      <PageHeader
        title="IoT & Smart Technology"
        subtitle="Hive boiler signals · parts cover · SMET2 pipeline · connected vans"
      />
      <div className="page-body">
        {/* Summary strip. Parts cover leads because it is the constraint: a fault
            we can predict but cannot stock is not a saved job. */}
        <div className="kpi-grid section-gap" style={{ '--col-min': '178px' } as React.CSSProperties}>
          <KPICard
            icon={PackageSearch} tooltipKey="Parts Cover" label="Parts Cover"
            value={pct(estate?.parts_cover_pct)} target={100} rag={coverRag}
          />
          <KPICard
            icon={PackageX} tooltipKey="Pre-positioning Blocked" label="Pre-positioning Blocked"
            value={estate?.pre_positioning_blocked ?? '—'} target={0}
            rag={estate ? (estate.pre_positioning_blocked === 0 ? 'G' : 'R') : undefined}
          />
          <KPICard
            icon={AlertTriangle} tooltipKey="Active Fault Signals" label="Active Fault Signals"
            value={faultList.length}
          />
          <KPICard
            icon={Radio} tooltipKey="Van Telemetry Health" label="Van Telemetry Health"
            value={pct(estate?.van_telemetry_health_pct)} target={95} rag={telemetryRag}
          />
          <KPICard
            icon={Zap} tooltipKey="SMET2 Installed YTD" label="SMET2 Installed YTD"
            value={smartMeter?.installed_total ?? '—'}
          />
        </div>

        {/* The exception this page exists to raise. Only rendered when it is real —
            a permanently-present "all clear" banner trains people to ignore it. */}
        {blocked.length > 0 && (
          <div className="card section-gap" style={{ borderLeft: '3px solid var(--clt-red)' }}>
            <div className="card-body" style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <MessageSquareWarning size={18} style={{ color: 'var(--clt-red)', flexShrink: 0, marginTop: 1 }} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 3 }}>
                  {blocked.length} predicted fault{blocked.length > 1 ? 's' : ''} cannot be covered
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  The part needed is on no van in the region and none is free at the NDC. Each of these is a
                  visit that will fail first time unless stock is moved — they are listed first below.
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="grid-2 section-gap">
          {/* Fault type distribution */}
          <div className="card">
            <div className="card-header"><div className="card-title">Fault Type Distribution</div></div>
            <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{ flex: '0 0 180px' }}>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={44} outerRadius={76} dataKey="value" isAnimationActive={false}>
                      {pieData.map((_, i) => <Cell key={i} fill={FAULT_COLORS[i % FAULT_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v: any) => [v, 'Faults']} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 9 }}>
                {pieData.map((entry, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: FAULT_COLORS[i % FAULT_COLORS.length], flexShrink: 0 }} />
                    <span style={{ fontSize: 12, textTransform: 'capitalize', color: 'var(--text-primary)', flex: 1 }}>{entry.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{pieTotal ? `${((entry.value / pieTotal) * 100).toFixed(0)}%` : ''}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', minWidth: 24, textAlign: 'right' }}>{entry.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* SMET2 Pipeline. Installed / target are the MHHS programme's own
              numbers, so this panel and the Demand module cannot disagree. */}
          {smartMeter && (
            <div className="card">
              <div className="card-header"><div className="card-title">SMET2 Smart Meter Pipeline</div></div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                    <span>Installed YTD</span>
                    <b>{smartMeter.installed_total?.toLocaleString()} / {smartMeter.target_fy?.toLocaleString()}</b>
                  </div>
                  <div className="progress-bar" style={{ height: 8 }}>
                    <div className="progress-fill blue" style={{ width: `${(smartMeter.installed_total / smartMeter.target_fy) * 100}%` }} />
                  </div>
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                    <span>DCC Registered</span>
                    <b>{smartMeter.dcc_registered?.toLocaleString()}</b>
                  </div>
                  <div className="progress-bar" style={{ height: 6 }}>
                    <div className="progress-fill green" style={{ width: `${(smartMeter.dcc_registered / smartMeter.installed_total) * 100}%` }} />
                  </div>
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                    <span>Firmware Updated</span>
                    <b>{smartMeter.firmware_updated?.toLocaleString()}</b>
                  </div>
                  <div className="progress-bar" style={{ height: 6 }}>
                    <div className="progress-fill green" style={{ width: `${(smartMeter.firmware_updated / smartMeter.installed_total) * 100}%` }} />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1, background: 'var(--clt-grey-50)', borderRadius: 6, padding: '10px 12px', fontSize: 12 }}>
                    <b>Commissioning failures (7d):</b> {smartMeter.commissioning_failures_7d}
                  </div>
                  {smartMeter.install_rate_per_week != null && (
                    <div style={{ flex: 1, background: 'var(--clt-grey-50)', borderRadius: 6, padding: '10px 12px', fontSize: 12 }}>
                      <b>Install rate:</b> {smartMeter.install_rate_per_week.toLocaleString()}/wk
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Active fault pipeline. Sorted worst-first by the API: uncovered signals
            lead, then by fault probability. */}
        <ActionedToday module="/iot" section="Demand Sensing" label="pre-positioning move"
          emptyHint="No stock pre-positioned against predicted demand today." />
        <div className="card section-gap">
          <div className="card-header">
            <div className="card-title">Active Fault Signals – Parts Cover</div>
            <div className="card-subtitle">
              Each signal joined to the part that clears it and where that part currently sits
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Device ID</th><th>Postcode</th><th>Region</th><th>Brand</th>
                <th>Age</th><th>Fault Type</th><th>Part Required</th>
                <th>Prob.</th><th>Cover</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {faultList.slice(0, 15).map((f, i) => {
                const cover = COVER_META[f.parts_cover] ?? COVER_META.none
                return (
                  <tr key={f.device_id ?? i}>
                    <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{f.device_id}</td>
                    <td>{f.property_postcode}</td>
                    <td style={{ fontSize: 11 }}>{f.region}</td>
                    <td style={{ fontWeight: 600 }}>{f.boiler_brand}</td>
                    <td>{f.boiler_age_years != null ? `${f.boiler_age_years.toFixed(0)}y` : '—'}</td>
                    <td style={{ fontSize: 11, textTransform: 'capitalize' }}>{title(f.fault_type)}</td>
                    <td style={{ fontSize: 11 }}>{f.required_part ?? '—'}</td>
                    <td>
                      <span style={{ fontWeight: 700, color: f.fault_probability > 0.85 ? 'var(--clt-red)' : f.fault_probability > 0.70 ? 'var(--clt-amber)' : 'var(--clt-green)' }}>
                        {(f.fault_probability * 100).toFixed(0)}%
                      </span>
                    </td>
                    {/* The badge is the decision; the line under it is the evidence,
                        so an operator can see why without opening anything. */}
                    <td>
                      <span className={`badge ${cover.badge}`}>{cover.label}</span>
                      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>{f.cover_detail}</div>
                    </td>
                    <td>
                      <span className={`badge ${f.pre_positioning_blocked ? 'badge-red'
                        : f.pre_positioning_triggered ? 'badge-blue' : 'badge-grey'}`}>
                        {f.pre_positioning_blocked ? 'Blocked'
                          : f.pre_positioning_triggered ? 'Pre-positioned' : 'Monitoring'}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Predictive replacements */}
        {predictive && predictive.length > 0 && (
          <div className="card">
            <ActionedToday module="/iot" section="Proactive Outreach" label="outreach campaign"
              emptyHint="No proactive outreach queued today." />
            <div className="card-header">
              <div className="card-title">Proactive Replacement Pipeline</div>
              <div className="card-subtitle">Properties flagged for outreach · 90-day replacement probability &gt;85%</div>
            </div>
            <table className="data-table">
              <thead>
                <tr><th>Postcode</th><th>Brand</th><th>Age</th><th>Replace Prob.</th><th>Est. Job Date</th><th>Outreach</th></tr>
              </thead>
              <tbody>
                {predictive.map((r, i) => (
                  <tr key={r.device_id ?? i}>
                    <td>{r.property_postcode}</td>
                    <td style={{ fontWeight: 600 }}>{r.boiler_brand}</td>
                    <td>{r.boiler_age_years?.toFixed(0)}y</td>
                    <td><span style={{ fontWeight: 700, color: 'var(--clt-red)' }}>{(r.replacement_probability_90d * 100).toFixed(0)}%</span></td>
                    <td>{r.estimated_job_date}</td>
                    <td><span className={`badge ${r.outreach_queued ? 'badge-green' : 'badge-grey'}`}>{r.outreach_queued ? 'Queued' : 'Pending'}</span></td>
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
