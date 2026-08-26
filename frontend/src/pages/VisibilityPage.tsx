import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { MapContainer, TileLayer, CircleMarker, Popup, ZoomControl } from 'react-leaflet'
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip as RTooltip } from 'recharts'
import { MetricTip } from '../components/ui/InfoTooltip'
import {
  Wifi, WifiOff, AlertTriangle, ChevronRight, Search, Radio,
  User, Box, Factory, CheckCircle, XCircle, Check, PackageX, Truck, MapPin,
  UserCheck, Navigation, Wrench, CalendarX,
} from 'lucide-react'
import {
  fetchMapData, fetchWarehouseHealth, fetchDashboard, fetchDemandNetwork,
  fetchVanAlerts, resolveVanAlert, fetchLockerMisses, resolveLockerMiss, fetchJobsAtRisk,
} from '../lib/api'
import {
  OptionList, ResolutionOutcome, SeverityPill, AllClear, FeedBadge, SEVERITY_COLOR,
  StateEngineBadge, ActionedToday,
} from '../components/ui/ResolutionPanel'
import { Divider, SectionLabel, Chip, EmptyNote, DetailHeader, DetailBadge, CardLink, CardSubLabel, OptionsHeader } from '../components/ui/PanelKit'
import {
  tone as toneOf, VAN_STATE_TONE, FreshnessMeter, SkeletonTiles, SkeletonRows,
} from '../components/ui/Telemetry'
import {
  useBasemap, useResizablePanel, PanelTabs, useHotkeys, ShortcutHint,
} from '../components/ui/MapWorkspace'
import { useWebSocket } from '../hooks/useWebSocket'
import { useStore } from '../store/useStore'
import { useTheme } from '../hooks/useTheme'
import { DARK, type AppColors } from '../lib/colors'
import 'leaflet/dist/leaflet.css'

// ─── constants ──────────────────────────────────────────────────────────────
//
// Colour is resolved from the theme, never written as a literal — see the same
// note on Transport Control. `.solid` for a filled mark (map pin, meter fill),
// `.text` for ink on a page surface, and the two are different values in dark
// mode by design.

const ENGINEER_STATES = ['available', 'en_route', 'on_site', 'break'] as const

const STATUS_LABEL: Record<string, string> = {
  available: 'Available', en_route: 'En Route', on_site: 'On Site', break: 'Break',
}

/** Engineer working state → the theme's tone. Shared table with Transport
 *  Control, so the two maps cannot drift to different greens. */
const engTone = (c: AppColors, status?: string) => toneOf(c, VAN_STATE_TONE[status ?? ''] ?? 'neutral')

// The hub strip is painted on `--clt-navy`, a fixed dark surface in BOTH
// themes, so it takes dark-mode ink whatever the app theme is: in light mode
// `--status-danger-text` is the deep red meant for a white page, which on navy
// is dark-on-dark.
const BAR = DARK
const BAR_DIM = 'rgba(255,255,255,0.45)'
const BU_LABEL: Record<string, string> = {
  boiler: 'Boiler', hive: 'Hive', heat_pump: 'Heat Pump',
  smart_meter: 'Smart Meter', ev_charger: 'EV Charger',
}

type Layer = 'engineers' | 'lockers' | 'warehouses'
type StatusFilter = 'all' | 'available' | 'en_route' | 'on_site' | 'van_low'
type BUFilter = 'all' | 'boiler' | 'hive' | 'heat_pump' | 'smart_meter'
type PanelView = 'overview' | 'engineers' | 'van_alerts' | 'warehouses' | 'lockers'

/** Warehouse throughput band → the theme's tone for it. */
function tpTone(c: AppColors, pct: number) {
  return pct < 40 ? c.danger : pct < 75 ? c.warning : c.success
}
/** …as ink. Marks (map pins, dots) take `tpTone(...).solid` instead. */
function tpColor(c: AppColors, pct: number) {
  return tpTone(c, pct).text
}

// ─── main page ───────────────────────────────────────────────────────────────

export function VisibilityPage() {
  const { c } = useTheme()
  // Live position patches keyed by engineer_code, merged onto the roster the
  // REST query owns — the socket never decides who is in the fleet.
  const [livePositions, setLivePositions] = useState<Record<string, any>>({})
  const [layers, setLayers] = useState<Set<Layer>>(new Set(['engineers', 'warehouses', 'lockers']))
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [buFilter, setBuFilter] = useState<BUFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedEng, setSelectedEng] = useState<any | null>(null)
  const [selectedWh, setSelectedWh] = useState<any | null>(null)
  const [panelView, setPanelView] = useState<PanelView>('overview')
  const [lockerFilter, setLockerFilter] = useState<'all' | 'alert'>('all')
  const [lastRefresh, setLastRefresh] = useState(new Date())
  const wsConnected = useStore(s => s.wsConnected)
  const user = useStore(s => s.user)
  const queryClient = useQueryClient()

  const { data: mapData } = useQuery({
    queryKey: ['map-data'],
    queryFn: () => fetchMapData(),
    refetchInterval: 30_000,
    refetchOnMount: 'always',
  })

  const { data: wh } = useQuery({
    queryKey: ['warehouse-health'],
    queryFn: fetchWarehouseHealth,
    refetchInterval: 30_000,
    refetchOnMount: 'always',
  })

  const { data: dash } = useQuery({
    queryKey: ['dashboard', 'logistics.ops'],
    queryFn: () => fetchDashboard('logistics.ops'),
    refetchInterval: 30_000,
  })

  // Van stock alerts and pre-8AM locker misses arrive with their resolution
  // options already priced against live state, so the panel never has to guess
  // what is possible — it renders what the engine says is possible.
  // Both poll at their own feed cadence (van stock scans / locker telemetry
  // settle on a 15-minute heartbeat), not on the fast map interval.
  const { data: vanAlertData } = useQuery({
    queryKey: ['van-alerts'],
    queryFn: () => fetchVanAlerts(),
    refetchInterval: 60_000,
    refetchOnMount: 'always',
  })

  const { data: lockerMissData } = useQuery({
    queryKey: ['locker-misses'],
    queryFn: () => fetchLockerMisses(),
    refetchInterval: 60_000,
    refetchOnMount: 'always',
  })

  // What the van-stock queue is actually COSTING, in appointments. The alert list
  // says how many vans are short; this says how many of today's jobs that puts at
  // risk — and it comes from the same cross-module aggregate the Executive
  // Dashboard headline uses, so the two cannot disagree.
  const { data: jobRisk } = useQuery({
    queryKey: ['jobs-at-risk'],
    queryFn: () => fetchJobsAtRisk(),
    refetchInterval: 20_000,
  })

  useEffect(() => {
    if (mapData?.engineers) setLastRefresh(new Date())
  }, [mapData])

  // Position ticks are PATCHES keyed by engineer_code, never a replacement
  // roster. Treating them as a roster is how the list flipped between 200 and
  // 50: a position payload carries only the fields that move, and whoever sends
  // it is entitled to send a subset. The REST query owns who exists; the socket
  // only ever says where they are.
  useWebSocket('visibility', useCallback((type: string, payload: any) => {
    if (type === 'engineer_location' && Array.isArray(payload)) {
      setLivePositions((prev) => {
        const next = { ...prev }
        for (const e of payload) if (e?.engineer_code) next[e.engineer_code] = e
        return next
      })
      setLastRefresh(new Date())
    }
    // Scenario/plan changes broadcast a fresh warehouse_status list on apply
    // (see backend apply_scenario) — write it straight into the query cache
    // so this page updates the instant it arrives instead of waiting for the
    // next 30s poll.
    if (type === 'throughput') { queryClient.setQueryData(['warehouse-health'], payload); setLastRefresh(new Date()) }
  }, [queryClient]))

  const engineers = useMemo<any[]>(() => {
    const roster: any[] = mapData?.engineers ?? []
    if (!roster.length) return roster
    return roster.map((e) => {
      const live = livePositions[e.engineer_code]
      return live ? { ...e, ...live } : e
    })
  }, [mapData, livePositions])
  const lockers: any[] = mapData?.lockers || []
  const warehouses: any[] = wh || []

  const filtered = engineers.filter((e) => {
    // Van Alert is a property filter, the others are job-status filters — but all
    // of them must still compose with business unit and search.
    if (statusFilter === 'van_low') {
      if (!e.van_stock_low) return false
    } else if (statusFilter !== 'all' && e.job_status !== statusFilter) {
      return false
    }
    if (buFilter !== 'all' && e.business_unit !== buFilter) return false
    if (search) {
      const q = search.trim().toLowerCase()
      return (e.name ?? '').toLowerCase().includes(q)
        || (e.region ?? '').toLowerCase().includes(q)
        || (e.engineer_code ?? '').toLowerCase().includes(q)   // the detail view shows the code, so it should be searchable
    }
    return true
  })

  // 500 lockers with a handful alerting were only visible as red dots on the map —
  // no count, no list, no way to reach them.
  const lockerAlerts = lockers.filter((l: any) => l.status === 'alert')

  const vanAlerts: any[] = vanAlertData?.items ?? []
  const openVanAlerts = vanAlerts.filter(a => a.status === 'open')
  const lockerMisses: any[] = lockerMissData?.items ?? []
  const openLockerMisses = lockerMisses.filter(m => m.status === 'open')

  const stats = {
    available: engineers.filter((e) => e.job_status === 'available').length,
    en_route: engineers.filter((e) => e.job_status === 'en_route').length,
    on_site: engineers.filter((e) => e.job_status === 'on_site').length,
    van_low: engineers.filter((e) => e.van_stock_low).length,
  }

  // Resolving anything touches engineers, routes, lockers and carrier legs at
  // once, so the whole affected surface is refetched rather than one list.
  const invalidateResolutions = useCallback(() => {
    for (const key of [['van-alerts'], ['locker-misses'], ['map-data'], ['warehouse-health'],
      ['dashboard', 'logistics.ops'], ['carrier-movements'], ['eta-risk'], ['fleet'], ['fleet-summary']]) {
      queryClient.invalidateQueries({ queryKey: key })
    }
  }, [queryClient])

  const vanResolveMut = useMutation({
    mutationFn: ({ code, action }: { code: string; action: string }) =>
      resolveVanAlert(code, action, user?.name ?? 'dispatcher'),
    onSuccess: invalidateResolutions,
  })

  const lockerResolveMut = useMutation({
    mutationFn: ({ site, action }: { site: string; action: string }) =>
      resolveLockerMiss(site, action, user?.name ?? 'dispatcher'),
    onSuccess: invalidateResolutions,
  })

  const toggleLayer = (l: Layer) =>
    setLayers((prev) => { const n = new Set(prev); n.has(l) ? n.delete(l) : n.add(l); return n })

  const selectEng = (e: any) => { setSelectedEng(e); setSelectedWh(null) }
  const selectWh = (w: any) => { setSelectedWh(w); setSelectedEng(null); setPanelView('warehouses') }
  const clearSelection = () => { setSelectedEng(null); setSelectedWh(null) }

  // ── Workspace shell ───────────────────────────────────────────────────────
  const basemap = useBasemap()
  const { pct: panelPct, frameRef, handleProps } = useResizablePanel('clt.visibility.panel', 40)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useHotkeys({
    Escape: () => clearSelection(),
    '/': (e) => { e.preventDefault(); setPanelView('engineers'); setTimeout(() => searchRef.current?.focus(), 0) },
    '1': () => setPanelView('overview'),
    '2': () => setPanelView('engineers'),
    '3': () => setPanelView('van_alerts'),
    '4': () => setPanelView('lockers'),
    '5': () => setPanelView('warehouses'),
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: c.surface }}>

      {/* ── STATUS BAR ─────────────────────────────────────────────────────── */}
      <div className="status-bar-scroll" data-tour="vis-statusbar" style={{
        display: 'flex', alignItems: 'center', gap: 18, padding: '9px 18px',
        background: 'var(--clt-navy)', flexShrink: 0,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        {/* A live socket is not the same claim as fresh data — the pipe can be
            up while the snapshot under it is twenty minutes old. This states the
            age of the data and offers the refetch. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {wsConnected
            ? <Wifi size={13} color={BAR.success.solid} aria-hidden="true" />
            : <WifiOff size={13} color={BAR.danger.solid} aria-hidden="true" />}
          <FreshnessMeter
            lastRefresh={mapData?.last_refresh ?? dash?.last_refresh}
            connected={wsConnected}
            onRefresh={() => queryClient.invalidateQueries()}
            compactMode
          />
        </div>

        <Divider />

        {/* Engineer pills */}
        {[
          { label: 'Available', val: stats.available, color: BAR.success.solid },
          { label: 'En Route', val: stats.en_route, color: BAR.info.solid },
          { label: 'On Site', val: stats.on_site, color: BAR.warning.solid },
        ].map(({ label, val, color }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, flexShrink: 0 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
            <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>{label}</span>
            <span style={{ fontWeight: 800, color: '#fff', fontSize: 13 }}>{val}</span>
          </div>
        ))}

        {openVanAlerts.length > 0 ? (
          <button
            onClick={() => { setStatusFilter('van_low'); setPanelView('van_alerts'); clearSelection() }}
            title="Open the van stock alert queue"
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, background: BAR.danger.bg, borderRadius: 6, padding: '2px 8px', border: `1px solid ${BAR.danger.border}`, cursor: 'pointer', flexShrink: 0 }}
          >
            <AlertTriangle size={12} color={BAR.danger.text} aria-hidden="true" />
            <span style={{ color: 'var(--status-danger-text)', fontWeight: 700 }}>
              {openVanAlerts.length} van alert{openVanAlerts.length === 1 ? '' : 's'}
            </span>
            {vanAlertData?.jobs_at_risk > 0 && (
              <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
                · {vanAlertData.jobs_at_risk} jobs
              </span>
            )}
          </button>
        ) : vanAlertData && (
          // A clear queue must LOOK clear. The old panel rendered identically
          // whether there were alerts or not, which taught operators to ignore it.
          <div
            title="Every van is at or above its minimum quantities"
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, background: BAR.success.bg, borderRadius: 6, padding: '2px 8px', border: `1px solid ${BAR.success.border}`, flexShrink: 0 }}
          >
            <CheckCircle size={12} color={BAR.success.text} aria-hidden="true" />
            <span style={{ color: 'var(--status-success-text)', fontWeight: 700 }}>Vans stocked</span>
          </div>
        )}

        {lockerAlerts.length > 0 && (
          <button
            onClick={() => { setPanelView('lockers'); setLockerFilter('alert'); clearSelection() }}
            title="Show only lockers needing attention"
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, background: BAR.warning.bg, borderRadius: 6, padding: '2px 8px', border: `1px solid ${BAR.warning.border}`, cursor: 'pointer', flexShrink: 0 }}
          >
            <Box size={12} color={BAR.warning.text} aria-hidden="true" />
            <span style={{ color: 'var(--status-warning-text)', fontWeight: 700 }}>{lockerAlerts.length} locker alerts</span>
            {openLockerMisses.length > 0 && (
              <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
                · {openLockerMisses.length} pre-8AM
              </span>
            )}
          </button>
        )}

        <Divider />

        {/* Warehouse throughput pills */}
        {warehouses.map((w: any) => (
          <button key={w.code} onClick={() => selectWh(w)} title={`Open ${w.name}`}
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: tpTone(BAR, w.throughput_vs_baseline_pct).solid }} />
            <span style={{ color: BAR_DIM }}>{w.code}</span>
            <span style={{ fontWeight: 700, color: tpColor(BAR, w.throughput_vs_baseline_pct) }}>
              {w.throughput_vs_baseline_pct.toFixed(0)}%
            </span>
          </button>
        ))}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: BAR_DIM }}>
            <Radio size={11} aria-hidden="true" />
            {lastRefresh.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
          <StateEngineBadge />
          {/* Shortcuts nobody can discover are shortcuts nobody uses. */}
          <ShortcutHint items={[
            ['Esc', 'Clear the current selection'],
            ['/', 'Search the field force'],
            ['1 – 5', 'Jump to a panel section'],
            ['← →', 'Move between sections (from a tab)'],
            ['?', 'Show or hide this list'],
          ]} />
        </div>
      </div>

      {/* ── BODY: MAP + PANEL ─────────────────────────────────────────────── */}
      {/* The split is the operator's, and it is remembered between sessions. */}
      <div ref={frameRef} style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0, position: 'relative' }}>

        {/* ── MAP ────────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>

          {/* Floating controls – top left */}
          <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 500, display: 'flex', flexDirection: 'column', gap: 8 }}>

            {/* Layer toggles */}
            <div data-tour="vis-layers" style={{
              background: 'rgba(8,13,28,0.93)',
              backdropFilter: 'blur(14px)',
              WebkitBackdropFilter: 'blur(14px)',
              borderRadius: 10,
              padding: '8px 10px',
              boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
              border: '1px solid rgba(255,255,255,0.12)',
              display: 'flex',
              gap: 5,
            }}>
              <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.35)', alignSelf: 'center', paddingRight: 6, borderRight: '1px solid rgba(255,255,255,0.12)', marginRight: 2 }}>
                Layers
              </span>
              {([
                { key: 'engineers', icon: User, label: 'Engineers' },
                { key: 'lockers', icon: Box, label: 'Lockers' },
                { key: 'warehouses', icon: Factory, label: 'Hubs' },
              ] as { key: Layer; icon: React.ElementType; label: string }[]).map(({ key, icon: Icon, label }) => (
                <button key={key} onClick={() => toggleLayer(key)} style={{
                  padding: '5px 11px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  border: layers.has(key) ? '1px solid rgba(251,78,11,0.7)' : '1px solid rgba(255,255,255,0.12)',
                  cursor: 'pointer',
                  background: layers.has(key) ? 'rgba(251,78,11,0.85)' : 'rgba(255,255,255,0.06)',
                  color: layers.has(key) ? '#fff' : 'rgba(255,255,255,0.55)',
                  transition: 'all 150ms',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  letterSpacing: '0.01em',
                }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon size={13} strokeWidth={1.8} />
                  </span>
                  <span>{label}</span>
                </button>
              ))}
            </div>

            {/* Status filters (only when engineers layer is on) */}
            {layers.has('engineers') && (
              <div style={{
                background: 'rgba(8,13,28,0.93)',
                backdropFilter: 'blur(14px)',
                WebkitBackdropFilter: 'blur(14px)',
                borderRadius: 10,
                padding: '9px 10px',
                boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
                border: '1px solid rgba(255,255,255,0.12)',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                minWidth: 168,
              }}>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.4)', padding: '2px 4px', marginBottom: 4 }}>
                  Filter Engineers
                </div>
                {([
                  { key: 'all' as StatusFilter, label: 'All Engineers', dot: null, color: BAR.textSecondary },
                  { key: 'available' as StatusFilter, label: 'Available', dot: BAR.success.solid, color: BAR.success.text },
                  { key: 'en_route' as StatusFilter, label: 'En Route', dot: BAR.info.solid, color: BAR.info.text },
                  { key: 'on_site' as StatusFilter, label: 'On Site', dot: BAR.warning.solid, color: BAR.warning.text },
                  { key: 'van_low' as StatusFilter, label: 'Van Alert', dot: BAR.danger.solid, color: BAR.danger.text },
                ]).map(({ key, label, dot, color }) => {
                  const active = statusFilter === key
                  return (
                    <button key={key} onClick={() => setStatusFilter(key)} style={{
                      padding: '6px 10px',
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: active ? 700 : 500,
                      border: active ? `1px solid ${color}70` : '1px solid transparent',
                      background: active ? color + '28' : 'transparent',
                      color: active ? color : 'rgba(255,255,255,0.45)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      textAlign: 'left',
                      transition: 'all 120ms',
                    }}>
                      {dot
                        ? <div style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0, boxShadow: active ? `0 0 6px ${dot}` : 'none' }} />
                        : <div style={{ width: 8, height: 8, borderRadius: 2, background: active ? '#c4d4e860' : 'rgba(255,255,255,0.18)', flexShrink: 0 }} />
                      }
                      {label}
                      {active && <Check size={12} style={{ marginLeft: 'auto' }} />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Legend – bottom left */}
          <div style={{
            position: 'absolute', bottom: 30, left: 12, zIndex: 500,
            background: 'rgba(10,16,32,0.82)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
            borderRadius: 10, padding: '10px 13px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
            fontSize: 11, display: 'flex', flexDirection: 'column', gap: 5,
          }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.35)', marginBottom: 2 }}>Legend</div>
            {ENGINEER_STATES.map((k) => (
              <HoverTooltip key={k} text={LEGEND_TIPS[k]} direction="right">
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'rgba(255,255,255,0.7)' }}>
                  <div style={{ width: 9, height: 9, borderRadius: '50%', background: engTone(c, k).solid, flexShrink: 0 }} />
                  {STATUS_LABEL[k]}
                </div>
              </HoverTooltip>
            ))}
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 5, marginTop: 2, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <HoverTooltip text={LEGEND_TIPS.van_alert} direction="right">
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'rgba(255,255,255,0.6)' }}>
                  <div style={{ width: 9, height: 9, borderRadius: '50%', border: '2px solid #EF4444', background: 'transparent', flexShrink: 0 }} />
                  Van stock alert
                </div>
              </HoverTooltip>
              <HoverTooltip text={LEGEND_TIPS.locker} direction="right">
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'rgba(255,255,255,0.6)' }}>
                  <div style={{ width: 9, height: 9, borderRadius: '50%', background: '#60A5FA', opacity: 0.7, flexShrink: 0 }} />
                  ByBox locker
                </div>
              </HoverTooltip>
            </div>
          </div>

          {/* Result count badge */}
          {layers.has('engineers') && (statusFilter !== 'all' || buFilter !== 'all' || search) && (
            <div style={{
              position: 'absolute', top: 12, right: 12, zIndex: 500,
              background: 'var(--clt-navy)', color: '#fff', borderRadius: 20,
              padding: '4px 12px', fontSize: 11, fontWeight: 700,
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            }}>
              {filtered.length} / {engineers.length} engineers
            </div>
          )}

          <MapContainer
            center={[52.8, -1.5]} zoom={6}
            style={{ height: '100%', width: '100%' }}
            zoomControl={false}
          >
            <ZoomControl position="bottomright" />
            {/* The basemap follows the theme — a night-shift operator on the
                dark console was being handed a floodlit white map. */}
            <TileLayer key={basemap.key} url={basemap.url} attribution={basemap.attribution} />

            {/* Locker dots */}
            {layers.has('lockers') && lockers.slice(0, 400).map((loc: any, i: number) => (
              <CircleMarker
                key={loc.bybox_site_code || i}
                center={[loc.latitude, loc.longitude]}
                radius={3}
                pathOptions={{
                  fillColor: loc.status === 'alert' ? c.danger.solid : c.info.solid,
                  fillOpacity: 0.55, color: 'transparent', weight: 0,
                }}
              >
                <Popup>
                  <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                    <b>{loc.bybox_site_code}</b><br />
                    Fill: {loc.fill_pct?.toFixed(0)}%<br />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                      Pre-8AM: {loc.pre_8am_delivered ? <><CheckCircle size={12} color={c.success.text} /> Delivered</> : <><XCircle size={12} color={c.danger.text} /> Missed</>}
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            ))}

            {/* Warehouse rings */}
            {layers.has('warehouses') && warehouses.map((w: any) => (
              <CircleMarker
                key={w.code}
                center={[w.latitude, w.longitude]}
                radius={14}
                pathOptions={{
                  fillColor: tpTone(c, w.throughput_vs_baseline_pct).solid,
                  fillOpacity: 0.18,
                  color: tpTone(c, w.throughput_vs_baseline_pct).solid,
                  weight: 3,
                }}
                eventHandlers={{ click: () => selectWh(w) }}
              >
                <Popup>
                  <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                    <b>{w.name}</b><br />
                    <span style={{ color: tpColor(c, w.throughput_vs_baseline_pct), fontWeight: 700 }}>
                      {w.throughput_vs_baseline_pct.toFixed(0)}% throughput
                    </span><br />
                    {w.items_per_hour.toLocaleString()} / {w.baseline_items_per_hour.toLocaleString()} items/hr<br />
                    Courier OT: {w.courier_ot_rate.toFixed(1)}%
                  </div>
                </Popup>
              </CircleMarker>
            ))}

            {/* Engineer dots */}
            {layers.has('engineers') && filtered.map((eng: any, i: number) => {
              const isSelected = selectedEng?.engineer_code === eng.engineer_code
              return (
                <CircleMarker
                  key={eng.engineer_code || i}
                  center={[eng.latitude, eng.longitude]}
                  radius={isSelected ? 8 : 5}
                  pathOptions={{
                    fillColor: engTone(c, eng.job_status).solid,
                    fillOpacity: isSelected ? 1 : 0.82,
                    color: eng.van_stock_low ? c.danger.solid : isSelected ? c.accentSolid : 'transparent',
                    weight: eng.van_stock_low ? 2 : isSelected ? 2 : 0,
                  }}
                  eventHandlers={{ click: () => selectEng(eng) }}
                >
                  <Popup>
                    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                      <b>{eng.name}</b><br />
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                        {BU_LABEL[eng.business_unit]}
                        {eng.van_stock_low && <> · <span style={{ color: 'var(--status-danger-text)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3 }}><AlertTriangle size={10} /> Van low</span></>}
                      </div>
                      <span style={{ color: engTone(c, eng.job_status).text, fontWeight: 700 }}>{STATUS_LABEL[eng.job_status]}</span>
                    </div>
                  </Popup>
                </CircleMarker>
              )
            })}
          </MapContainer>
        </div>

        {/* ── RIGHT PANEL ─────────────────────────────────────────────────── */}
        <div {...handleProps} />
        <div style={{
          width: `${panelPct}%`, flexShrink: 0, background: c.surface,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          {selectedEng ? (
            <EngineerDetail eng={selectedEng} onBack={clearSelection}
              alert={vanAlerts.find(a => a.engineer_code === selectedEng.engineer_code)}
              onResolve={(action: string) => vanResolveMut.mutate({ code: selectedEng.engineer_code, action })}
              pending={vanResolveMut.isPending ? (vanResolveMut.variables as any)?.action : null} />
          ) : selectedWh ? (
            <WarehouseDetail wh={selectedWh} onBack={clearSelection} />
          ) : (
            <>
              <PanelTabs
                idPrefix="visibility"
                active={panelView}
                onChange={setPanelView}
                tabs={[
                  { key: 'overview', label: 'Overview' },
                  { key: 'engineers', label: `Field (${filtered.length})` },
                  { key: 'van_alerts', label: 'Van Alerts', count: openVanAlerts.length },
                  { key: 'lockers', label: 'Lockers', count: openLockerMisses.length },
                  { key: 'warehouses', label: 'Hubs' },
                ]}
              />

              <div
                role="tabpanel"
                id={`visibility-panel-${panelView}`}
                aria-labelledby={`visibility-tab-${panelView}`}
                tabIndex={0}
                style={{ flex: 1, overflowY: 'auto', padding: 14 }}
              >
                {panelView === 'overview' && (
                  <OverviewPanel stats={stats} warehouses={warehouses} dash={dash}
                    lockers={lockers} lockerAlerts={lockerAlerts.length}
                    vanAlertData={vanAlertData} lockerMissData={lockerMissData}
                    jobRisk={jobRisk}
                    onViewVanAlerts={() => setPanelView('van_alerts')}
                    onViewLockers={() => { setPanelView('lockers'); setLockerFilter('alert') }} />
                )}
                {panelView === 'engineers' && (
                  <EngineersPanel
                    engineers={filtered} allCount={engineers.length}
                    search={search} setSearch={setSearch}
                    buFilter={buFilter} setBuFilter={setBuFilter}
                    onSelect={selectEng}
                    searchRef={searchRef}
                  />
                )}
                {panelView === 'van_alerts' && (
                  <VanAlertsPanel
                    data={vanAlertData}
                    onResolve={(code: string, action: string) => vanResolveMut.mutate({ code, action })}
                    pendingCode={vanResolveMut.isPending ? (vanResolveMut.variables as any)?.code : null}
                    pendingAction={vanResolveMut.isPending ? (vanResolveMut.variables as any)?.action : null}
                    error={(vanResolveMut.data as any)?.error}
                    onOpenEngineer={(code: string) => {
                      const eng = engineers.find(e => e.engineer_code === code)
                      if (eng) selectEng(eng)
                    }}
                  />
                )}
                {panelView === 'lockers' && (
                  <LockersPanel
                    lockers={lockers} filter={lockerFilter} setFilter={setLockerFilter}
                    missData={lockerMissData}
                    onResolve={(site: string, action: string) => lockerResolveMut.mutate({ site, action })}
                    pendingSite={lockerResolveMut.isPending ? (lockerResolveMut.variables as any)?.site : null}
                    pendingAction={lockerResolveMut.isPending ? (lockerResolveMut.variables as any)?.action : null}
                    error={(lockerResolveMut.data as any)?.error}
                  />
                )}
                {panelView === 'warehouses' && (
                  <WarehousesPanel warehouses={warehouses} onSelect={selectWh} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── hover tooltip ───────────────────────────────────────────────────────────

const FIELD_TIPS: Record<string, string> = {
  available: 'Engineers ready for immediate dispatch — no active job assigned. Higher numbers mean faster P1 response times.',
  en_route: 'Engineers currently driving to a job site. Positions update every 30 seconds via GPS. Blue dots on the map.',
  on_site: 'Engineers actively working at a customer property. Amber dots on the map. Click a dot to see van stock and job details.',
  van_low: 'Engineers with one or more van stock items below the minimum threshold. Replenishment should be arranged to avoid job failures.',
}

const LEGEND_TIPS: Record<string, string> = {
  available: 'Green dot — engineer ready for dispatch, no active job assigned.',
  en_route: 'Blue dot — engineer driving to their current job site.',
  on_site: 'Amber dot — engineer actively working at a customer property.',
  break: 'Grey dot — engineer on a scheduled break, not available for dispatch.',
  van_alert: 'Red ring — engineer van has one or more parts below minimum quantity. Needs replenishment.',
  locker: 'Blue dot — ByBox smart locker location. Click for fill level and pre-8AM delivery status.',
}

function HoverTooltip({
  text, children, direction = 'top',
}: { text: string; children: React.ReactNode; direction?: 'top' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null)

  function handleMouseEnter() {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    if (direction === 'right') {
      setCoords({ x: r.right + 10, y: r.top + r.height / 2 })
    } else {
      setCoords({ x: r.left + r.width / 2, y: r.top - 10 })
    }
  }

  return (
    <div ref={ref} style={{ cursor: 'default' }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setCoords(null)}
    >
      {children}
      {coords && (
        <div style={{
          position: 'fixed',
          left: coords.x,
          top: coords.y,
          transform: direction === 'right' ? 'translateY(-50%)' : 'translate(-50%, -100%)',
          width: 220,
          background: '#1E293B',
          color: '#F1F5F9',
          fontSize: 11,
          lineHeight: 1.55,
          borderRadius: 7,
          padding: '8px 11px',
          boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
          zIndex: 9999,
          pointerEvents: 'none',
          whiteSpace: 'normal',
        }}>
          {text}
        </div>
      )}
    </div>
  )
}

// ─── helper components ───────────────────────────────────────────────────────

// ─── Overview panel ──────────────────────────────────────────────────────────

function OverviewPanel({ stats, warehouses, dash, lockers = [], lockerAlerts = 0,
  vanAlertData, lockerMissData, jobRisk, onViewVanAlerts, onViewLockers }: any) {
  const { c } = useTheme()
  const excSummary = dash?.exceptions_summary
  const kpis = dash?.kpis
  const navigate = useNavigate()
  const lockerHealthyPct = lockers.length ? ((lockers.length - lockerAlerts) / lockers.length) * 100 : 100
  const openVan = (vanAlertData?.items ?? []).filter((a: any) => a.status === 'open').length
  const openMisses = (lockerMissData?.items ?? []).filter((m: any) => m.status === 'open').length

  // The shape shown while loading is the shape that arrives.
  if (!dash && !stats) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div><SectionLabel>Field Force</SectionLabel><SkeletonTiles count={4} /></div>
        <div><SectionLabel>Needs Working</SectionLabel><SkeletonRows count={3} height={46} /></div>
        <div><SectionLabel>Network</SectionLabel><SkeletonTiles count={4} /></div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* Field force grid */}
      <div data-tour="vis-field-force">
        <SectionLabel>Field Force</SectionLabel>
        <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px' } as React.CSSProperties}>
          {[
            { key: 'available', label: 'Available', color: c.success.text, kpiKey: 'Available for Dispatch', icon: <UserCheck size={14} /> },
            { key: 'en_route', label: 'En Route', color: c.info.text, kpiKey: 'En Route', icon: <Navigation size={14} /> },
            { key: 'on_site', label: 'On Site', color: c.warning.text, kpiKey: 'Engineers On-Site', icon: <Wrench size={14} /> },
            { key: 'van_low', label: 'Van Alerts', color: c.danger.text, kpiKey: 'Van Stock Low', icon: <PackageX size={14} /> },
          ].map(({ key, label, color, kpiKey, icon }) => (
            <MetricTip key={key} label={kpiKey} title={label} block>
              <div style={{
                background: color + '12', border: `1px solid ${color}2e`,
                borderRadius: 8, padding: '11px 13px',
              }}>
                {/* Icon is decoration — the label beside it already names the
                    measure, so it carries no meaning of its own (SC 1.4.1). */}
                <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ color }} aria-hidden="true">{icon}</span>{label}
                </div>
                <div style={{ fontSize: 24, fontWeight: 900, color, lineHeight: 1 }}>{stats[key]}</div>
              </div>
            </MetricTip>
          ))}
        </div>
      </div>

      {/* ── What the shortages cost, in appointments ────────────────────────
          The Field Force tiles above count vans; the queues below count alerts.
          Neither answers the question a service director actually asks, which is
          how many of today's customers are going to be let down. This sits
          between them because it is the consequence of the one and the reason for
          the other — and it is the same figure the Executive Dashboard leads on,
          read from the same endpoint so the two can never drift. */}
      <div data-tour="vis-jobs-risk">
        <SectionLabel right={<FeedBadge label="Van stock + routes" interval="20s" />}>
          Jobs at SLA Risk — Today
        </SectionLabel>
        <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px' } as React.CSSProperties}>
          <MetricTip label="Jobs at Risk · Parts" title="No part in van" block>
            <div style={{
              background: (jobRisk?.parts_shortage ?? 0) > 0 ? '#EF444412' : 'var(--clt-grey-50)',
              border: `1px solid ${(jobRisk?.parts_shortage ?? 0) > 0 ? '#EF44442e' : 'var(--clt-grey-200)'}`,
              borderRadius: 8, padding: '11px 13px', height: '100%',
            }}>
              <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span
                  style={{ color: (jobRisk?.parts_shortage ?? 0) > 0 ? '#EF4444' : 'var(--clt-grey-400)' }}
                  aria-hidden="true"
                ><PackageX size={14} /></span>
                No part in van
              </div>
              <div style={{
                fontSize: 24, fontWeight: 900, lineHeight: 1,
                color: (jobRisk?.parts_shortage ?? 0) > 0 ? '#EF4444' : 'var(--clt-grey-300)',
              }}>
                {jobRisk ? jobRisk.parts_shortage : '—'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginTop: 4 }}>
                {jobRisk
                  ? `across ${jobRisk.rounds_short_of_stock} round${jobRisk.rounds_short_of_stock === 1 ? '' : 's'} out of stock`
                  : ' '}
              </div>
            </div>
          </MetricTip>
          <MetricTip label="Jobs at SLA Risk" title="Network total" block>
            <div style={{
              background: 'var(--clt-grey-50)', border: '1px solid var(--clt-grey-200)',
              borderRadius: 8, padding: '11px 13px', height: '100%',
            }}>
              <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ color: 'var(--clt-grey-400)' }} aria-hidden="true"><CalendarX size={14} /></span>
                All causes
              </div>
              <div style={{ fontSize: 24, fontWeight: 900, lineHeight: 1, color: 'var(--clt-grey-900)' }}>
                {jobRisk ? jobRisk.at_risk : '—'}
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--clt-grey-500)', marginLeft: 3 }}>
                  {jobRisk ? `of ${jobRisk.total_jobs.toLocaleString()} remaining` : ''}
                </span>
              </div>
              {/* Stated as "+N also" rather than as a second number to add: a job
                  short of parts on a round that is ALSO running late appears in
                  both causes, so the two never sum to the total. */}
              <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginTop: 4 }}>
                {jobRisk ? `${jobRisk.arrival_delay} also at risk from arrival delay` : ' '}
              </div>
            </div>
          </MetricTip>
        </div>
      </div>

      {/* Work queues — the two alert families that carry their own resolutions.
          Both read as unmistakably clear when they are clear. */}
      <div data-tour="vis-queues">
        <SectionLabel>Action Queues</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <QueueRow
            icon={<PackageX size={14} />}
            label="Van stock alerts"
            tip="Van Stock Alerts"
            count={openVan}
            detail={openVan
              ? `${vanAlertData?.jobs_at_risk ?? 0} job(s) at risk · transfer, reallocate, collect en route or replenish`
              : 'Every van at or above minimum quantities'}
            onOpen={onViewVanAlerts}
          />
          <QueueRow
            icon={<Truck size={14} />}
            label="Pre-8AM locker misses"
            tip="Pre-8AM Locker Misses"
            count={openMisses}
            detail={openMisses
              ? `${lockerMissData?.engineers_affected ?? 0} engineer(s) stranded · failover, catch-up drop or hub collection`
              : 'Every site took its overnight wave'}
            onOpen={onViewLockers}
          />
        </div>
      </div>

      {/* Live exceptions */}
      <div>
        <SectionLabel right={
          <CardLink onClick={() => navigate('/exceptions')} title="Open the exceptions queue">
            View all
          </CardLink>
        }>
          Live Exceptions
        </SectionLabel>

        {excSummary ? (
          <div className="auto-grid" style={{ '--cols': '4', '--col-min': '96px', '--grid-gap': '6px' } as React.CSSProperties}>
            {([
              // These are OPEN counts, not exceptions raised over a period — the
              // summary is recomputed from current status on every state sync.
              { label: 'Total', value: (excSummary.p1 ?? 0) + (excSummary.p2 ?? 0) + (excSummary.p3 ?? 0), color: c.ai.text, kpiKey: 'Open Exceptions' },
              { label: 'P1', value: excSummary.p1 ?? 0, color: c.danger.text, kpiKey: 'P1 Exceptions' },
              { label: 'P2', value: excSummary.p2 ?? 0, color: c.warning.text, kpiKey: 'P2 Exceptions' },
              { label: 'P3', value: excSummary.p3 ?? 0, color: c.warning.text, kpiKey: 'P3 Exceptions' },
            ]).map(({ label, value, color, kpiKey }) => {
              const card = (
                <div key={label} style={{
                  textAlign: 'center', borderRadius: 7, padding: '10px 4px',
                  background: value > 0 ? color + '14' : 'var(--clt-grey-50)',
                  border: `1px solid ${value > 0 ? color + '45' : 'var(--clt-grey-200)'}`,
                }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: value > 0 ? color : 'var(--clt-grey-300)', lineHeight: 1 }}>{value}</div>
                  <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: value > 0 ? color : 'var(--clt-grey-400)', marginTop: 3 }}>{label}</div>
                </div>
              )
              return kpiKey ? (
                <MetricTip key={label} label={kpiKey} title={label} block>
                  {card}
                </MetricTip>
              ) : card
            })}
          </div>
        ) : (
          <EmptyNote>Loading…</EmptyNote>
        )}
      </div>

      {/* KPIs */}
      {kpis && (
        <div data-tour="vis-kpis">
          <SectionLabel>Key Performance Indicators</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {[
              { key: 'first_time_fix_rate', label: 'First Time Fix Rate' },
              { key: 'pre_8am_success_rate', label: 'Pre-8AM Delivery' },
              { key: 'in_boot_availability', label: 'In-Boot Availability' },
              { key: 'expediting_cost_pct', label: 'Expediting Cost', invertRag: true },
            ].map(({ key, label }) => {
              const kpi = kpis[key]
              if (!kpi) return null
              const rc = kpi.rag === 'G' ? '#10B981' : kpi.rag === 'A' ? '#F59E0B' : '#EF4444'
              const pct = kpi.unit === 'pct' ? Math.min(100, (kpi.value / (kpi.target * 1.3)) * 100) : 80
              return (
                <MetricTip key={key} label={key} title={label} block>
                  <div style={{ padding: '9px 11px', background: 'var(--clt-grey-50)', borderRadius: 7, border: '1px solid var(--clt-grey-100)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                      <span style={{ fontSize: 11, color: 'var(--clt-grey-600)' }}>{label}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ fontSize: 14, fontWeight: 800, color: rc }}>
                          {kpi.value}{kpi.unit === 'pct' ? '%' : ''}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--clt-grey-400)' }}>
                          / {kpi.target}{kpi.unit === 'pct' ? '%' : ''}
                        </span>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: rc, flexShrink: 0 }} />
                      </div>
                    </div>
                    <div style={{ height: 4, background: 'var(--clt-grey-200)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: rc, borderRadius: 2, transition: 'width 0.5s ease' }} />
                    </div>
                  </div>
                </MetricTip>
              )
            })}
          </div>
        </div>
      )}

      {/* Warehouse summary */}
      <div data-tour="vis-throughput">
        <SectionLabel>Warehouse Throughput</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {warehouses.map((w: any) => {
            const pct = w.throughput_vs_baseline_pct
            const tpCol = tpColor(c, pct)
            return (
              <MetricTip key={w.code} label="Throughput vs Baseline" title={w.name} block>
              <div style={{
                padding: '9px 11px', borderRadius: 7,
                background: w.is_disrupted ? c.danger.bg : c.surfaceSubtle,
                border: `1px solid ${w.is_disrupted ? c.danger.border : c.borderSubtle}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary }}>{w.name}</div>
                    <div style={{ fontSize: 11, color: c.textMuted }}>{w.operator}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 16, fontWeight: 900, color: tpCol, lineHeight: 1 }}>{pct.toFixed(0)}%</div>
                    <div style={{ fontSize: 11, color: c.textMuted }}>{w.items_per_hour.toLocaleString()} /hr</div>
                  </div>
                </div>
                <div style={{ height: 4, background: c.surfaceMuted, borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: tpCol, borderRadius: 2, transition: 'width 0.5s ease' }} />
                </div>
                {w.is_disrupted && (
                  <div style={{ fontSize: 11, color: 'var(--status-danger-text)', fontWeight: 700, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <AlertTriangle size={10} /> DISRUPTED — Playbook activation recommended
                  </div>
                )}
              </div>
              </MetricTip>
            )
          })}
        </div>
      </div>

      {/* Locker network — the third map layer, previously the only one with no
          presence in the overview at all. */}
      {lockers.length > 0 && (
        <div>
          <SectionLabel right={lockerAlerts > 0 && onViewLockers ? (
            <CardLink onClick={onViewLockers} title="Open the locker alert queue">
              View {lockerAlerts} alert{lockerAlerts === 1 ? '' : 's'}
            </CardLink>
          ) : undefined}>
            Locker Network
          </SectionLabel>
          <MetricTip label="Locker Network Health" title="ByBox smart lockers" block>
          <div style={{
            padding: '9px 11px', borderRadius: 7,
            background: lockerAlerts > 0 ? c.warning.bg : c.surfaceSubtle,
            border: `1px solid ${lockerAlerts > 0 ? c.warning.border : c.borderSubtle}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary }}>ByBox smart lockers</div>
                <div style={{ fontSize: 11, color: c.textMuted }}>
                  {lockers.length.toLocaleString()} sites · {lockerAlerts} needing attention
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 16, fontWeight: 900, lineHeight: 1, color: lockerHealthyPct >= 95 ? '#10B981' : lockerHealthyPct >= 85 ? '#F59E0B' : '#EF4444' }}>
                  {lockerHealthyPct.toFixed(1)}%
                </div>
                <div style={{ fontSize: 11, color: c.textMuted }}>healthy</div>
              </div>
            </div>
            <div style={{ height: 4, background: c.surfaceMuted, borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${Math.min(100, lockerHealthyPct)}%`, borderRadius: 2,
                background: lockerHealthyPct >= 95 ? '#10B981' : lockerHealthyPct >= 85 ? '#F59E0B' : '#EF4444',
                transition: 'width 0.5s ease',
              }} />
            </div>
          </div>
          </MetricTip>
        </div>
      )}
    </div>
  )
}

// A queue that is empty has to look different from a queue that is full —
// same row, opposite reading.
function QueueRow({ icon, label, count, detail, onOpen, tip }: {
  icon: React.ReactNode; label: string; count: number; detail: string
  onOpen?: () => void
  /** KPI_DEFINITIONS key — explains what lands in this queue and how it is closed. */
  tip?: string
}) {
  const { c } = useTheme()
  const clear = count === 0
  const tone = clear ? '#10B981' : count >= 5 ? '#EF4444' : '#F59E0B'

  // The row both explains itself and opens its queue, so MetricTip IS the button
  // rather than wrapping one — a nested button would put two tab stops on a
  // single row (see the note on MetricTip).
  const body = (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
        padding: '10px 12px', borderRadius: 8,
        background: clear ? c.surfaceSubtle : tone + '0f',
        border: `1px solid ${clear ? c.borderSubtle : tone + '3d'}`,
      }}
    >
      <span style={{ color: tone, display: 'flex', flexShrink: 0 }} aria-hidden="true">
        {clear ? <CheckCircle size={14} /> : icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: c.textPrimary }}>{label}</div>
        <div style={{ fontSize: 11, color: c.textSecondary, marginTop: 1, lineHeight: 1.4 }}>{detail}</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 900, color: tone, lineHeight: 1 }}>
          {clear ? '✓' : count}
        </div>
        <div style={{ fontSize: 11, color: c.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {clear ? 'clear' : 'open'}
        </div>
      </div>
      {onOpen && <ChevronRight size={13} color={c.textMuted} style={{ flexShrink: 0 }} aria-hidden="true" />}
    </div>
  )

  if (!tip && !onOpen) return body
  return (
    <MetricTip
      label={tip ?? label}
      title={label}
      block
      onActivate={onOpen}
      activateLabel={onOpen
        ? `${label}: ${clear ? 'clear' : `${count} open`}. ${detail}. Open queue`
        : undefined}
    >
      {body}
    </MetricTip>
  )
}

// ─── Engineers panel ─────────────────────────────────────────────────────────

function EngineersPanel({ engineers, allCount, search, setSearch, buFilter, setBuFilter, onSelect, searchRef }: any) {
  const { c } = useTheme()
  return (
    <div>
      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 10 }}>
        <Search size={13} aria-hidden="true" style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: c.textMuted, pointerEvents: 'none' }} />
        <input
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or region…"
          aria-label="Search the field force by name or region"
          style={{
            width: '100%', padding: '7px 10px 7px 28px', borderRadius: 6,
            border: `1px solid ${c.border}`, fontSize: 12,
            background: c.surfaceSubtle, color: c.textPrimary,
          }}
        />
        {search && (
          <button onClick={() => setSearch('')} style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', cursor: 'pointer', color: 'var(--clt-grey-400)', fontSize: 14, lineHeight: 1,
          }}>×</button>
        )}
      </div>

      {/* BU filter chips */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
        {(['all', 'boiler', 'hive', 'heat_pump', 'smart_meter'] as BUFilter[]).map((bu) => (
          <button key={bu} onClick={() => setBuFilter(bu)} style={{
            padding: '3px 9px', fontSize: 11, fontWeight: 600, borderRadius: 20,
            border: `1px solid ${buFilter === bu ? 'var(--exl-orange)' : c.border}`,
            background: buFilter === bu ? 'var(--exl-orange)' : 'transparent',
            color: buFilter === bu ? '#fff' : c.textSecondary,
            cursor: 'pointer', transition: 'all 120ms',
          }}>
            {bu === 'all' ? 'All BUs' : BU_LABEL[bu]}
          </button>
        ))}
      </div>

      {/* Count */}
      <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', marginBottom: 8 }}>
        Showing {Math.min(engineers.length, 100)} of {engineers.length}
        {engineers.length < allCount ? ` filtered from ${allCount}` : ''}
      </div>

      {/* List */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {engineers.slice(0, 100).map((eng: any) => (
          <button
            key={eng.engineer_code}
            onClick={() => onSelect(eng)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px',
              borderRadius: 6, cursor: 'pointer', border: 'none', background: 'transparent',
              width: '100%', textAlign: 'left', transition: 'background 100ms',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = c.surfaceSubtle)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <div style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: engTone(c, eng.job_status).solid }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {eng.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--clt-grey-400)' }}>
                {BU_LABEL[eng.business_unit] || eng.business_unit} · {eng.region}
              </div>
            </div>
            {eng.van_stock_low && <AlertTriangle size={13} color={c.danger.text} />}
            <ChevronRight size={13} color="var(--clt-grey-300)" />
          </button>
        ))}
        {engineers.length > 100 && (
          <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', textAlign: 'center', padding: '10px 0' }}>
            + {engineers.length - 100} more — refine filter to narrow results
          </div>
        )}
        {engineers.length === 0 && (
          <EmptyNote>No engineers match current filters</EmptyNote>
        )}
      </div>
    </div>
  )
}

// ─── Van Alerts panel ────────────────────────────────────────────────────────
// The old behaviour: clicking "N van alerts" applied a filter to the Engineers
// list, which rendered exactly the same rows in exactly the same way whether
// there were alerts or not — an operator could not tell a healthy fleet from a
// broken one, and there was nothing to DO from it either way.
//
// This is a queue instead: what is short, what it puts at risk, and the four
// courses of action available for that specific van, each priced.

function VanAlertsPanel({ data, onResolve, pendingCode, pendingAction, error, onOpenEngineer }: {
  data: any
  onResolve: (code: string, action: string) => void
  pendingCode: string | null
  pendingAction: string | null
  error?: string
  onOpenEngineer: (code: string) => void
}) {
  const { c } = useTheme()
  const [severity, setSeverity] = useState<'all' | 'critical' | 'high' | 'medium'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)

  if (!data) {
    return <div style={{ textAlign: 'center', padding: '24px 0', color: c.textMuted, fontSize: 12 }}>Loading…</div>
  }

  const all: any[] = data.items ?? []
  const open = all.filter(a => a.status === 'open')
  const resolved = all.filter(a => a.status === 'resolved')

  // The empty state is deliberately a different shape, not the same list with
  // zero rows — that difference is the whole point of the tab.
  if (open.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <AllClear
          title="No van is below minimum"
          body={resolved.length
            ? `Every van in the field is at or above its minimum quantities. ${resolved.length} alert${resolved.length === 1 ? ' was' : 's were'} worked this session.`
            : 'Every van in the field is at or above its minimum quantities on the lines it carries. Nothing here needs a decision.'}
        />
        {resolved.length > 0 && (
          <div>
            <SectionLabel>Worked this session ({resolved.length})</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {resolved.slice(0, 12).map((a) => (
                <div key={a.alert_id}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: c.textPrimary, marginBottom: 3 }}>
                    {a.engineer_name} · {a.region}
                  </div>
                  <ResolutionOutcome resolution={a.resolution} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  const shown = severity === 'all' ? open : open.filter(a => a.severity === severity)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* An alert ATLAS cleared leaves no trace on this queue — the van simply is
          not short any more. The audit trail is where the morning's work is. */}
      <ActionedToday module="/visibility" section="Van Stock Alerts" label="van alert" />
      {/* Scoreboard */}
      <div className="auto-grid" style={{ '--cols': '3', '--col-min': '118px', '--grid-gap': '7px' } as React.CSSProperties}>
        {[
          { label: 'Open', value: open.length, color: c.danger.text, tip: 'Van Stock Alerts' },
          { label: 'Jobs at risk', value: data.jobs_at_risk ?? 0, color: c.warning.text, tip: 'Jobs at Risk · Van Stock' },
          { label: 'Resolved', value: resolved.length, color: c.success.text, tip: 'Alerts Resolved' },
        ].map(({ label, value, color, tip }) => (
          <MetricTip key={label} label={tip} title={label} block>
            <div style={{
              background: color + '12', border: `1px solid ${color}2e`,
              borderRadius: 8, padding: '9px 11px', height: '100%',
            }}>
              <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 21, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
            </div>
          </MetricTip>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        {(['all', 'critical', 'high', 'medium'] as const).map((s) => {
          const n = s === 'all' ? open.length : open.filter(a => a.severity === s).length
          return (
            <button key={s} onClick={() => setSeverity(s)} disabled={n === 0 && s !== 'all'} style={{
              padding: '3px 9px', fontSize: 11, fontWeight: 700, borderRadius: 20,
              border: `1px solid ${severity === s ? (SEVERITY_COLOR[s] ?? 'var(--exl-orange)') : c.border}`,
              background: severity === s ? (SEVERITY_COLOR[s] ?? 'var(--exl-orange)') : 'transparent',
              color: severity === s ? '#fff' : n === 0 ? c.textMuted : c.textSecondary,
              cursor: n === 0 && s !== 'all' ? 'default' : 'pointer', textTransform: 'capitalize',
            }}>
              {s} ({n})
            </button>
          )
        })}
        <FeedBadge label="Van stock" interval="15m" />
      </div>

      {error && (
        <div style={{
          fontSize: 11, color: c.danger.text, background: c.danger.bg,
          border: `1px solid ${c.danger.border}`, borderRadius: 7, padding: '7px 10px',
        }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {shown.map((a) => {
          const isOpen = expanded === a.engineer_code
          const sev = SEVERITY_COLOR[a.severity]
          return (
            <div key={a.alert_id} style={{
              border: `1px solid ${isOpen ? sev + '66' : c.border}`, borderRadius: 9,
              background: c.surface, overflow: 'hidden',
            }}>
              <button
                onClick={() => setExpanded(isOpen ? null : a.engineer_code)}
                style={{
                  width: '100%', textAlign: 'left', background: isOpen ? sev + '0d' : 'transparent',
                  border: 'none', cursor: 'pointer', padding: '10px 12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                  <PackageX size={13} color={sev} style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: c.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.engineer_name}
                  </span>
                  <SeverityPill severity={a.severity} />
                </div>
                <div style={{ fontSize: 11, color: c.textMuted, marginBottom: 5 }}>
                  {a.registration ?? a.engineer_code} · {a.region} · {a.jobs_at_risk} stop{a.jobs_at_risk === 1 ? '' : 's'} left
                </div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {a.shortfall.slice(0, 3).map((it: any) => (
                    <span key={it.sku_code} title={it.description} style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                      background: c.danger.bg, color: c.danger.text, border: `1px solid ${c.danger.border}`,
                    }}>
                      {it.sku_code} · {it.quantity}/{it.min_quantity}
                    </span>
                  ))}
                  {a.shortfall.length > 3 && (
                    <span style={{ fontSize: 11, color: c.textMuted, alignSelf: 'center' }}>
                      +{a.shortfall.length - 3} more
                    </span>
                  )}
                </div>
                {a.next_job && (
                  <div style={{ fontSize: 11, color: c.textSecondary, marginTop: 5, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <MapPin size={9} />
                    Next: {a.next_job.job_type?.replace(/_/g, ' ')} · {a.next_job.postcode} · {a.next_job.planned_arrival}
                  </div>
                )}
              </button>

              {isOpen && (
                <div style={{ padding: '0 12px 12px', borderTop: `1px solid ${c.borderSubtle}` }}>
                  <OptionsHeader>
                    <CardLink
                      onClick={() => onOpenEngineer(a.engineer_code)}
                      title={`Open ${a.engineer_name}'s van`}
                    >
                      Open van
                    </CardLink>
                  </OptionsHeader>
                  <OptionList
                    options={a.options ?? []}
                    onApply={(action) => onResolve(a.engineer_code, action)}
                    pending={pendingCode === a.engineer_code ? pendingAction : null}
                  />
                </div>
              )}
            </div>
          )
        })}
        {shown.length === 0 && (
          <EmptyNote>No {severity} alerts open</EmptyNote>
        )}
      </div>
    </div>
  )
}

// ─── Lockers panel ───────────────────────────────────────────────────────────
// The locker network is a first-class map layer and has its own failure scenario,
// but alerting sites were previously only findable by spotting a red dot — and a
// pre-8AM miss, the failure that actually costs an engineer their morning, had
// no resolution path at all.

function LockersPanel({
  lockers, filter, setFilter, missData, onResolve, pendingSite, pendingAction, error,
}: {
  lockers: any[]; filter: 'all' | 'alert'; setFilter: (f: 'all' | 'alert') => void
  missData?: any
  onResolve: (site: string, action: string) => void
  pendingSite: string | null
  pendingAction: string | null
  error?: string
}) {
  const { c } = useTheme()
  const [q, setQ] = useState('')
  const alerts = lockers.filter((l) => l.status === 'alert')
  const shown = lockers
    .filter((l) => (filter === 'alert' ? l.status === 'alert' : true))
    .filter((l) => {
      if (!q.trim()) return true
      const n = q.trim().toLowerCase()
      return (l.bybox_site_code ?? '').toLowerCase().includes(n)
        || (l.region ?? '').toLowerCase().includes(n)
        || (l.postcode ?? '').toLowerCase().includes(n)
    })
    // worst first: pre-8AM misses ahead of the merely full
    .sort((a, b) => (a.pre_8am_delivered === b.pre_8am_delivered
      ? (b.fill_pct ?? 0) - (a.fill_pct ?? 0)
      : a.pre_8am_delivered ? 1 : -1))

  const healthyPct = lockers.length ? ((lockers.length - alerts.length) / lockers.length) * 100 : 100
  const misses: any[] = missData?.items ?? []
  const openMisses = misses.filter((m) => m.status === 'open')
  const resolvedMisses = misses.filter((m) => m.status === 'resolved')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ── Pre-8AM misses ───────────────────────────────────────────────────
          A locker over 85% full is a housekeeping problem. A site that missed
          the overnight wave is an engineer standing in a car park at 07:40 with
          no part, and it has a short window in which it can still be fixed —
          so it leads the panel and carries its own actions. */}
      <div>
        <SectionLabel right={<FeedBadge label="Locker telemetry" interval="15m" />}>
          Pre-8AM misses {openMisses.length > 0 ? `(${openMisses.length})` : ''}
        </SectionLabel>
        <ActionedToday module="/visibility" section="Pre-8AM Misses" label="miss" />
        {openMisses.length === 0 ? (
          <AllClear
            title="Every site took its overnight wave"
            body={resolvedMisses.length
              ? `No site is waiting on a pre-8AM delivery. ${resolvedMisses.length} miss${resolvedMisses.length === 1 ? ' was' : 'es were'} worked this session.`
              : 'No site is waiting on a pre-8AM delivery — every engineer can collect before their first appointment.'}
          />
        ) : (
          <>
            <div style={{
              fontSize: 11, color: c.textSecondary, lineHeight: 1.55, marginBottom: 9,
              background: c.warning.bg, border: `1px solid ${c.warning.border}`, borderRadius: 7, padding: '7px 10px',
            }}>
              <b>{missData?.engineers_affected ?? 0} engineer(s)</b> and{' '}
              <b>{missData?.jobs_at_risk ?? 0} job(s)</b> depend on these sites this morning.
            </div>
            {error && (
              <div style={{
                fontSize: 11, color: c.danger.text, background: c.danger.bg,
                border: `1px solid ${c.danger.border}`, borderRadius: 7, padding: '7px 10px', marginBottom: 9,
              }}>
                {error}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {openMisses.slice(0, 12).map((m) => (
                <LockerMissCard
                  key={m.site_code} miss={m}
                  onResolve={(action: string) => onResolve(m.site_code, action)}
                  pending={pendingSite === m.site_code ? pendingAction : null}
                />
              ))}
              {openMisses.length > 12 && (
                <div style={{ fontSize: 11, color: c.textMuted, textAlign: 'center', padding: '4px 0' }}>
                  + {openMisses.length - 12} more site(s) — work the worst first
                </div>
              )}
            </div>
          </>
        )}
        {resolvedMisses.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
            {resolvedMisses.slice(0, 6).map((m) => (
              <div key={m.site_code}>
                <div style={{ fontSize: 11, fontWeight: 700, color: c.textPrimary, marginBottom: 3, fontFamily: 'monospace' }}>
                  {m.site_code}
                </div>
                <ResolutionOutcome resolution={m.resolution} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: c.borderSubtle }} />

      <SectionLabel>Locker Network</SectionLabel>
      <ActionedToday module="/visibility" section="Locker Network" label="locker action"
        emptyHint="No locker failovers or unlocks today." />
      <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px' } as React.CSSProperties}>
        {/* healthyPct is the share of sites NOT flagged for attention — a site is
            flagged for a missed pre-8AM wave OR for being over 85% full — so it is
            network health, not the count of compartments pre-loaded overnight. */}
        <MetricTip label="Locker Network Health" title="Network health" block>
          <div style={{ background: '#10B98112', border: '1px solid #10B9812e', borderRadius: 8, padding: '11px 13px' }}>
            <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ color: c.success.text }} aria-hidden="true"><CheckCircle size={14} /></span>
              Network healthy
            </div>
            <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--status-success-text)', lineHeight: 1 }}>{healthyPct.toFixed(1)}%</div>
          </div>
        </MetricTip>
        <MetricTip label="Locker Gaps" title="Needing attention" block>
          <div style={{ background: alerts.length ? '#F59E0B12' : 'var(--clt-grey-50)', border: `1px solid ${alerts.length ? '#F59E0B2e' : 'var(--clt-grey-200)'}`, borderRadius: 8, padding: '11px 13px' }}>
            <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ color: alerts.length ? '#F59E0B' : 'var(--clt-grey-400)' }} aria-hidden="true"><AlertTriangle size={14} /></span>
              Needs attention
            </div>
            <div style={{ fontSize: 24, fontWeight: 900, color: alerts.length ? '#F59E0B' : 'var(--clt-grey-300)', lineHeight: 1 }}>{alerts.length}</div>
          </div>
        </MetricTip>
      </div>

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {(['all', 'alert'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: '3px 9px', fontSize: 11, fontWeight: 600, borderRadius: 20,
            border: `1px solid ${filter === f ? 'var(--exl-orange)' : c.border}`,
            background: filter === f ? 'var(--exl-orange)' : 'transparent',
            color: filter === f ? '#fff' : c.textSecondary,
            cursor: 'pointer', transition: 'all 120ms',
          }}>
            {f === 'all' ? `All (${lockers.length})` : `Needs attention (${alerts.length})`}
          </button>
        ))}
      </div>

      <div style={{ position: 'relative' }}>
        <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--clt-grey-400)', pointerEvents: 'none' }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search site code, postcode or region…"
          aria-label="Search lockers"
          style={{
            width: '100%', fontSize: 12, padding: '7px 10px 7px 28px', borderRadius: 6,
            border: `1px solid ${c.border}`, background: c.surfaceSubtle, color: c.textPrimary,
          }}
        />
        {q && (
          <button onClick={() => setQ('')} style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', cursor: 'pointer', color: 'var(--clt-grey-400)', fontSize: 14, lineHeight: 1,
          }}>×</button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {shown.slice(0, 100).map((l) => {
          const tone = l.status === 'alert' ? '#F59E0B' : '#10B981'
          return (
            <div key={l.bybox_site_code} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px',
              borderBottom: `1px solid ${c.borderSubtle}`,
            }}>
              <div style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: tone }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary, fontFamily: 'monospace' }}>{l.bybox_site_code}</div>
                <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {l.region}{l.postcode ? ` · ${l.postcode}` : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: (l.fill_pct ?? 0) > 85 ? '#EF4444' : c.textSecondary, fontVariantNumeric: 'tabular-nums' }}>
                  {(l.fill_pct ?? 0).toFixed(0)}% full
                </div>
                <div style={{ fontSize: 11, color: l.pre_8am_delivered ? '#10B981' : '#EF4444', fontWeight: 700 }}>
                  {l.pre_8am_delivered ? 'pre-8AM ok' : 'pre-8AM missed'}
                </div>
              </div>
            </div>
          )
        })}
        {shown.length > 100 && (
          <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', textAlign: 'center', padding: '10px 0' }}>
            + {shown.length - 100} more — refine the search to narrow results
          </div>
        )}
        {shown.length === 0 && (
          <EmptyNote>{filter === 'alert' ? 'No lockers need attention' : 'No lockers match the search'}</EmptyNote>
        )}
      </div>
    </div>
  )
}

// One missed site: why it missed, who it strands, and what can still be done
// about it before the first appointment.

function LockerMissCard({ miss, onResolve, pending }: {
  miss: any; onResolve: (action: string) => void; pending: string | null
}) {
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  const sev = SEVERITY_COLOR[miss.severity] ?? '#F59E0B'
  return (
    <div style={{
      border: `1px solid ${open ? sev + '66' : c.border}`, borderRadius: 9,
      background: c.surface, overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', textAlign: 'left', background: open ? sev + '0d' : 'transparent',
          border: 'none', cursor: 'pointer', padding: '10px 12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
          <Box size={13} color={sev} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, fontWeight: 700, color: c.textPrimary, fontFamily: 'monospace', flex: 1 }}>
            {miss.site_code}
          </span>
          <SeverityPill severity={miss.severity} />
        </div>
        <div style={{ fontSize: 11, color: c.textMuted, marginBottom: 5 }}>
          {miss.region}{miss.postcode ? ` · ${miss.postcode}` : ''} · {(miss.fill_pct ?? 0).toFixed(0)}% full
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: sev, marginBottom: 2 }}>
          {miss.reason_label}
        </div>
        <div style={{ fontSize: 11, color: c.textSecondary, lineHeight: 1.45 }}>
          {miss.reason_detail}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 11, color: c.textSecondary }}>
          <span><b style={{ color: c.textPrimary }}>{miss.engineers_affected}</b> engineer{miss.engineers_affected === 1 ? '' : 's'}</span>
          <span><b style={{ color: c.textPrimary }}>{miss.jobs_at_risk}</b> job{miss.jobs_at_risk === 1 ? '' : 's'}</span>
          <span>first job <b style={{ color: c.textPrimary }}>{miss.first_job_at}</b></span>
        </div>
      </button>
      {open && (
        <div style={{ padding: '0 12px 12px', borderTop: `1px solid ${c.borderSubtle}` }}>
          <OptionsHeader />
          <OptionList options={miss.options ?? []} onApply={onResolve} pending={pending} />
        </div>
      )}
    </div>
  )
}

// ─── Warehouses panel ────────────────────────────────────────────────────────

function WarehousesPanel({ warehouses, onSelect }: any) {
  const { c } = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {warehouses.map((w: any) => {
        const pct = w.throughput_vs_baseline_pct
        const tp = tpColor(c, pct)
        return (
          // One tab stop per site: MetricTip is the button, so the card both
          // explains what "% vs baseline" means and opens the site's detail view.
          <MetricTip
            key={w.code}
            label="Throughput vs Baseline"
            title={w.name}
            block
            onActivate={() => onSelect(w)}
            activateLabel={`${w.name}: ${pct.toFixed(0)}% of baseline throughput, ${w.items_per_hour.toLocaleString()} items per hour. Open site`}
          >
          <div
            style={{
              border: '1px solid var(--clt-grey-200)', borderRadius: 9,
              padding: '13px 14px', cursor: 'pointer', background: 'var(--bg-card)',
              textAlign: 'left', width: '100%', transition: 'box-shadow 150ms',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.boxShadow = 'none')}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--clt-grey-900)' }}>{w.name}</div>
                <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', marginTop: 1 }}>
                  {w.operator} · {w.type.replace(/_/g, ' ')}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 22, fontWeight: 900, color: tp, lineHeight: 1 }}>{pct.toFixed(0)}%</div>
                <div style={{ fontSize: 11, color: 'var(--clt-grey-400)' }}>vs baseline</div>
              </div>
            </div>

            {/* 24h sparkline */}
            <div style={{ height: 44, margin: '4px 0 8px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={w.throughput_chart || []} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id={`g-${w.code}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={tp} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={tp} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area type="monotone" dataKey="items_per_hour" stroke={tp} strokeWidth={2} fill={`url(#g-${w.code})`} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="auto-grid" style={{ '--cols': '3', '--col-min': '118px', '--grid-gap': '6px' } as React.CSSProperties}>
              {[
                { label: 'Items/hr', val: w.items_per_hour.toLocaleString() },
                { label: 'Courier OT', val: `${w.courier_ot_rate.toFixed(1)}%` },
                { label: 'Staff', val: w.staff_present },
              ].map(({ label, val }) => (
                <div key={label} style={{ background: 'var(--clt-grey-50)', borderRadius: 5, padding: '5px 7px' }}>
                  <div style={{ fontSize: 11, color: 'var(--clt-grey-400)' }}>{label}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--clt-grey-900)' }}>{val}</div>
                </div>
              ))}
            </div>
          </div>
          </MetricTip>
        )
      })}
    </div>
  )
}

// ─── Engineer detail ─────────────────────────────────────────────────────────

function EngineerDetail({ eng, onBack, alert, onResolve, pending }: {
  eng: any; onBack: () => void
  alert?: any; onResolve?: (action: string) => void; pending?: string | null
}) {
  const { c } = useTheme()
  const sc = engTone(c, eng.job_status).solid
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <DetailHeader onBack={onBack}>
        <DetailBadge tone={sc}>{STATUS_LABEL[eng.job_status] || eng.job_status}</DetailBadge>
      </DetailHeader>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {/* Identity */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--clt-grey-900)', marginBottom: 2 }}>{eng.name}</div>
          <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', marginBottom: 8 }}>{eng.engineer_code}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Chip>{BU_LABEL[eng.business_unit] || eng.business_unit}</Chip>
            <Chip>{eng.region}</Chip>
          </div>
        </div>

        {/* Van alert — a banner that only announces the problem is a dead end,
            so the resolution options for THIS van sit directly beneath it. */}
        {eng.van_stock_low && (
          <div style={{ marginBottom: 14 }}>
            <div style={{
              background: 'var(--status-danger-bg)', border: '1px solid var(--status-danger-border)',
              borderRadius: alert?.status === 'open' ? '8px 8px 0 0' : 8,
              padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'flex-start',
            }}>
              <AlertTriangle size={16} color={c.danger.text} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--status-danger-text)' }}>Van Stock Alert</span>
                  {alert && <SeverityPill severity={alert.severity} />}
                </div>
                <div style={{ fontSize: 11, color: 'var(--status-danger-text)', marginTop: 2 }}>
                  {alert
                    ? `${alert.shortfall_units} unit(s) short across ${alert.shortfall.length} line(s) with ${alert.jobs_at_risk} stop(s) left today.`
                    : 'One or more items are below minimum threshold. Replenishment required.'}
                </div>
              </div>
            </div>
            {alert?.status === 'open' && onResolve && (
              <div style={{
                border: '1px solid var(--status-danger-border)', borderTop: 'none', borderRadius: '0 0 8px 8px',
                padding: '10px 12px', background: 'var(--clt-grey-50)',
              }}>
                <CardSubLabel style={{ marginBottom: 8 }}>Options</CardSubLabel>
                <OptionList options={alert.options ?? []} onApply={onResolve} pending={pending ?? null} />
              </div>
            )}
            {alert?.status === 'resolved' && (
              <div style={{ marginTop: 8 }}>
                <ResolutionOutcome resolution={alert.resolution} />
              </div>
            )}
          </div>
        )}

        {/* Van stock table */}
        <div style={{ marginBottom: 16 }}>
          <SectionLabel>Van Stock Inventory</SectionLabel>
          <div style={{ border: '1px solid var(--clt-grey-200)', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--clt-grey-50)' }}>
                  {['SKU / Description', 'Qty', 'Min', ''].map((h) => (
                    <th key={h} style={{ padding: '7px 10px', textAlign: h === 'Qty' || h === 'Min' ? 'center' : 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--clt-grey-500)', borderBottom: '1px solid var(--clt-grey-200)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(eng.van_stock_items || []).map((item: any, i: number) => (
                  <tr key={i} style={{ background: item.is_below_min ? '#FEF2F2' : 'transparent', borderTop: '1px solid var(--clt-grey-100)' }}>
                    <td style={{ padding: '8px 10px' }}>
                      <div style={{ fontWeight: 600, fontSize: 11 }}>{item.sku_code}</div>
                      <div style={{ fontSize: 11, color: 'var(--clt-grey-400)' }}>{item.description}</div>
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700 }}>{item.quantity}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'center', color: 'var(--clt-grey-400)' }}>{item.min_quantity}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                      {item.is_below_min
                        ? <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--status-danger-text)' }}>LOW</span>
                        : <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--status-success-text)' }}>OK</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Location */}
        <div>
          <SectionLabel>Location</SectionLabel>
          <div style={{ background: 'var(--clt-grey-50)', borderRadius: 7, padding: '10px 12px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--clt-grey-900)' }}>{eng.region}</div>
            <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', marginTop: 2 }}>
              {eng.latitude?.toFixed(4)}°N, {Math.abs(eng.longitude ?? 0).toFixed(4)}°W
            </div>
            <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', marginTop: 1 }}>Home: {eng.home_postcode}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Warehouse detail ────────────────────────────────────────────────────────

function WarehouseDetail({ wh, onBack }: { wh: any; onBack: () => void }) {
  const { c } = useTheme()
  const tp = tpColor(c, wh.throughput_vs_baseline_pct)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <DetailHeader onBack={onBack}>
        {wh.is_disrupted && (
          <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', padding: '2px 9px', borderRadius: 20, background: 'var(--status-danger-bg)', color: 'var(--status-danger-text)' }}>
            Disrupted
          </span>
        )}
      </DetailHeader>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {/* Identity */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--clt-grey-900)', marginBottom: 2 }}>{wh.name}</div>
          <div style={{ fontSize: 11, color: 'var(--clt-grey-400)' }}>{wh.operator} · {wh.type.replace(/_/g, ' ')} · {wh.code}</div>
        </div>

        {/* Big throughput hero */}
        <div style={{
          background: tpTone(c, wh.throughput_vs_baseline_pct).bg,
          border: `1px solid ${tpTone(c, wh.throughput_vs_baseline_pct).border}`, borderRadius: 12,
          padding: '18px', marginBottom: 16, textAlign: 'center',
        }}>
          {/* The one hero figure on this view. Proportional figures, not
              tabular — a display-size number set in tabular digits reads loose. */}
          <div style={{ fontSize: 48, fontWeight: 900, color: tp, lineHeight: 1 }}>
            {wh.throughput_vs_baseline_pct.toFixed(0)}%
          </div>
          <div style={{ fontSize: 12, color: 'var(--clt-grey-500)', marginTop: 4 }}>throughput vs baseline</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--clt-grey-700)', marginTop: 4 }}>
            {wh.items_per_hour.toLocaleString()} / {wh.baseline_items_per_hour.toLocaleString()} items/hr
          </div>
          {Math.round(wh.throughput_vs_baseline_pct) < 40 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--status-danger-bg)', color: 'var(--status-danger-text)', fontSize: 11, padding: '4px 8px', borderRadius: 4, fontWeight: 600, marginTop: 8 }}>
              <AlertTriangle size={12} /> Below P1 threshold (40%)
            </div>
          )}
        </div>

        {/* 24h trend */}
        <div style={{ marginBottom: 16 }}>
          <SectionLabel>24h Throughput Trend</SectionLabel>
          <div style={{ height: 110 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={wh.throughput_chart || []} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
                <defs>
                  <linearGradient id={`wg-${wh.code}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={tp} stopOpacity={0.28} />
                    <stop offset="95%" stopColor={tp} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="hour" tick={{ fontSize: 11, fill: 'var(--clt-grey-400)' }} tickLine={false} axisLine={false}
                  tickFormatter={(h: number) => h % 6 === 0 ? `${String(h).padStart(2, '0')}:00` : ''} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--clt-grey-400)' }} tickLine={false} axisLine={false} width={34}
                  tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)} />
                <RTooltip
                  formatter={(v: any) => [`${Number(v).toLocaleString()} items/hr`]}
                  labelFormatter={(h: any) => `${String(h).padStart(2, '0')}:00`}
                  contentStyle={{ fontSize: 11, borderRadius: 6, border: '1px solid var(--clt-grey-200)', boxShadow: 'var(--shadow-sm)' }}
                />
                <Area type="monotone" dataKey="items_per_hour" stroke={tp} strokeWidth={2} fill={`url(#wg-${wh.code})`} dot={false} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Stock position — the demand module's view of this same site */}
        <StockPositionPanel code={wh.code} />

        {/* Stats */}
        <div>
          <SectionLabel>Operational Details</SectionLabel>
          <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px' } as React.CSSProperties}>
            {[
              { label: 'Courier OT Rate', val: `${wh.courier_ot_rate.toFixed(1)}%`, alert: wh.courier_ot_rate < 85, tip: 'Courier OT Rate' },
              { label: 'Staff Present', val: wh.staff_present, tip: 'Staff Present' },
              { label: 'Labour Risk', val: `${wh.labour_risk_score}/100`, alert: wh.labour_risk_score > 60, tip: 'Labour Risk Score' },
              { label: 'Baseline', val: `${wh.baseline_items_per_hour.toLocaleString()}/hr`, tip: 'Baseline Throughput' },
            ].map(({ label, val, alert, tip }) => (
              <MetricTip key={label} label={tip} title={label} block>
                <div style={{
                  background: alert ? '#FEF2F2' : 'var(--clt-grey-50)',
                  border: `1px solid ${alert ? '#FCA5A5' : 'var(--clt-grey-100)'}`,
                  borderRadius: 7, padding: '9px 11px', height: '100%',
                }}>
                  <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: alert ? '#EF4444' : 'var(--clt-grey-900)' }}>{val}</div>
                </div>
              </MetricTip>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// Stock position for one site, read from the demand engine's network view so the
// throughput picture here and the inventory picture there can never disagree.
function StockPositionPanel({ code }: { code: string }) {
  const navigate = useNavigate()
  const { data: network } = useQuery({
    queryKey: ['demand-network'], queryFn: fetchDemandNetwork, refetchInterval: 60_000,
  })
  const site = useMemo(() => {
    if (!network) return null
    if (network.ndc?.warehouse_code === code) return network.ndc
    return (network.hubs ?? []).find((h: any) => h.warehouse_code === code) ?? null
  }, [network, code])

  if (!site) return null
  const isNdc = site.role === 'ndc'
  const stats = [
    { label: 'Units On Hand', val: (site.units_on_hand ?? 0).toLocaleString(), tip: 'Units On Hand' },
    { label: 'Days of Cover', val: `${site.avg_days_of_supply ?? 0}d`, alert: (site.avg_days_of_supply ?? 0) < 5, tip: 'Days of Cover' },
    { label: 'SKUs at Risk', val: (site.skus_at_risk ?? 0).toLocaleString(), alert: (site.skus_at_risk ?? 0) > 0, tip: 'SKUs at Risk' },
    { label: 'Stockouts', val: (site.stockouts ?? 0).toLocaleString(), alert: (site.stockouts ?? 0) > 0, tip: 'Stockouts' },
  ]
  return (
    <div style={{ marginBottom: 16 }}>
      <SectionLabel>Stock Position</SectionLabel>
      <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px', marginBottom: 8 } as React.CSSProperties}>
        {stats.map(({ label, val, alert, tip }) => (
          <MetricTip key={label} label={tip} title={label} block>
            <div style={{
              background: alert ? '#FEF2F2' : 'var(--clt-grey-50)',
              border: `1px solid ${alert ? '#FCA5A5' : 'var(--clt-grey-100)'}`,
              borderRadius: 7, padding: '9px 11px', height: '100%',
            }}>
              <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: alert ? '#EF4444' : 'var(--clt-grey-900)' }}>{val}</div>
            </div>
          </MetricTip>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 8 }}>
        {isNdc
          ? 'Replenished by supplier purchase orders — the only site suppliers deliver into.'
          : `Replenished by stock transport orders this hub raises on the NDC${site.transfer_lead_days ? ` · ${site.transfer_lead_days}d trunker` : ''}${site.inbound_transfers ? ` · ${site.inbound_transfers} inbound` : ''}.`}
      </div>
      <button
        onClick={() => navigate(`/demand?scope=${encodeURIComponent(code)}`)}
        style={{
          width: '100%', fontSize: 11.5, fontWeight: 700, padding: '8px 10px', borderRadius: 7,
          cursor: 'pointer', background: 'var(--clt-grey-50)', color: 'var(--clt-grey-700)',
          border: '1px solid var(--clt-grey-200)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}
      >
        Open in Demand &amp; Inventory <ChevronRight size={13} />
      </button>
    </div>
  )
}

// ─── shared sub-components ───────────────────────────────────────────────────

