import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MapContainer, TileLayer, CircleMarker, Circle, Popup, Polyline, Marker, Tooltip as LTooltip, ZoomControl } from 'react-leaflet'
import L from 'leaflet'
import {
  Wifi, WifiOff, AlertTriangle, ChevronRight, Search,
  ClipboardCheck, Wrench, ShieldAlert, Zap, Gauge, Radio, Route as RouteIcon, PiggyBank, XCircle,
  Package, Boxes, Home, Clock, TimerOff, PackageCheck, Truck, Leaf,
} from 'lucide-react'
import {
  fetchFleet, fetchFleetSummary, fetchCazZones, fetchMapData,
  fetchRouteOptimization, fetchEngineerRoute,
  completeWalkaround, resolveVehicleDefect,
  fetchCarrierMovements, resolveCarrierMovement, fetchEtaRisk, resolveEtaRisk, fetchJobsAtRisk,
  optimizeEngineerRoute,
} from '../lib/api'
import { MetricTip } from '../components/ui/InfoTooltip'
import {
  OptionList, ResolutionOutcome, SeverityPill, AllClear, FeedBadge, SEVERITY_COLOR,
  StateEngineBadge, ActionedToday,
} from '../components/ui/ResolutionPanel'
import { Divider, SectionLabel, Chip, EmptyNote, DetailHeader, DetailBadge, CardLink, CardSubLabel, OptionsHeader } from '../components/ui/PanelKit'
// `tone` is imported under a distinct name: several components on this page
// already have a local `tone` holding a resolved colour string, and a shadowed
// helper fails at runtime rather than at the type check.
import {
  tone as toneOf, ToneName, VAN_STATE_TONE, SEVERITY_TONE,
  StatTile as Tile, StatusDot, FreshnessMeter, SkeletonTiles, SkeletonRows,
} from '../components/ui/Telemetry'
import {
  useBasemap, useResizablePanel, PanelTabs, useHotkeys, ShortcutHint,
} from '../components/ui/MapWorkspace'
import { useWebSocket } from '../hooks/useWebSocket'
import { useStore } from '../store/useStore'
import { useTheme } from '../hooks/useTheme'
import { DARK, type AppColors } from '../lib/colors'
import 'leaflet/dist/leaflet.css'

// The status strip is painted on `--clt-navy` — a fixed dark surface in BOTH
// themes. So it takes dark-mode ink whatever the app theme is. This is not a
// preference: in light mode `--status-danger-text` resolves to the deep red
// meant for a white page, which on navy is dark-on-dark. The pale steps are the
// ones verified against a near-black surface, so the bar reads from those.
const BAR = DARK
const BAR_DIM = 'rgba(255,255,255,0.45)'

// ─── constants (aligned with Live Visibility Hub) ────────────────────────────
//
// Colour is resolved from the theme, never written as a literal. The two are
// not interchangeable: `colors.ts` documents that dark mode is deliberately not
// an inversion — status foregrounds move to the pale end of each ramp because
// the saturated mid-tones that read well on white go muddy on near-black. A
// literal #EF4444 lands at ~3.3:1 on the dark surface; the `danger.text` token
// it bypasses is 9.4:1.
//
// Two different jobs, two different steps:
//   `.solid`  a filled mark — map pin, meter fill, count pill. Same in both modes.
//   `.text`   ink on a page surface. Different per mode, and AA-verified.

const VAN_STATES = ['available', 'en_route', 'on_site', 'break', 'off_duty'] as const

const STATUS_LABEL: Record<string, string> = {
  available: 'Available', en_route: 'En Route', on_site: 'On Site', break: 'Break', off_duty: 'Off Duty',
}

/** Working state of a van/engineer → the theme's tone for it. */
const vanTone = (c: AppColors, status?: string) => toneOf(c, VAN_STATE_TONE[status ?? ''] ?? 'neutral')

/** Where a third-party leg has got to → tone. `delayed` is not a status the
 *  API returns; lateness is a separate flag, handled at the call site. */
const MOVEMENT_TONE: Record<string, ToneName> = {
  booked: 'neutral', collected: 'info', in_transit: 'info',
  out_for_delivery: 'warning', delivered: 'success', delayed: 'danger',
}
const movementTone = (c: AppColors, status?: string, late?: boolean) =>
  toneOf(c, late ? 'danger' : MOVEMENT_TONE[status ?? ''] ?? 'info')

// 'drivers' was a tab of its own until every figure it carried — score, harsh
// braking, speeding, idling — turned out to be on the van's detail view already.
// What it uniquely offered was the ranking, i.e. a way to FIND the drivers who
// need coaching, so that survives as a block on Overview rather than a tab.
type PanelView = 'overview' | 'compliance' | 'routes' | 'carriers' | 'vehicles'
type FleetFilter = 'all' | 'vor' | 'walkaround_missing' | 'defects' | 'mot_due' | 'caz_risk' | 'ev'
type CarrierFilter = 'delayed' | 'all' | 'locker' | 'in_boot' | 'job_site'
type MapLayer = 'vans' | 'carriers' | 'caz'

// Road speed on a drawn route. These stay saturated in both themes because they
// are strokes on a basemap, not ink on a page — and they ship with a word in
// every tooltip, so the encoding is never colour alone.
const CONGESTION_TONE: Record<string, ToneName> = {
  free: 'success', moderate: 'warning', heavy: 'danger',
}
const congestionColor = (c: AppColors, k: string) => toneOf(c, CONGESTION_TONE[k] ?? 'neutral').solid

// Where a third-party leg is going. The part decides the channel: small parts
// to a locker for pre-8AM collection or into the engineer's boot overnight;
// anything bulky (outdoor units, cylinders, full boiler swaps) two-man to the
// customer address on the day, because it fits in neither.
const DEST_META: Record<string, { label: string; icon: React.ElementType; tone: ToneName }> = {
  locker:   { label: 'ByBox locker', icon: Boxes, tone: 'info' },
  in_boot:  { label: 'In-boot (van)', icon: Package, tone: 'ai' },
  job_site: { label: 'Job address', icon: Home, tone: 'accent' },
}

function fmtEta(iso?: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function fmtDelay(mins: number) {
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

// Fleet-wide default view (whole GB service area) vs. a focused single-van view.
// Leaflet zoom 6 ≈ country level; 13 ≈ streets/neighbourhood level — the point
// where the van's own postcode area and nearby roads are legible without
// losing the surrounding context a dispatcher needs. When a route with
// multiple stops is drawn we instead fit-to-bounds (capped at 14) so every
// stop stays visible rather than zooming past them.
const DEFAULT_CENTER: [number, number] = [52.8, -1.5]
const DEFAULT_ZOOM = 6
const VAN_ZOOM = 13
const ROUTE_MAX_ZOOM = 14

const incidentIcon = (emoji: string) => L.divIcon({
  html: `<div style="font-size:17px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4))">${emoji}</div>`,
  className: 'route-incident-icon',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
})

// Carrier drops are squares, vans are circles. Shape carries the distinction
// rather than colour alone, because colour is already doing status work on both
// layers and a red dot next to a red square must not read as the same thing.
const carrierIcon = (color: string, bulky: boolean, selected: boolean) => {
  const s = selected ? 20 : bulky ? 16 : 13
  return L.divIcon({
    html: `<div style="
      width:${s}px;height:${s}px;border-radius:${bulky ? 3 : 4}px;
      background:${color};border:2px solid #fff;
      box-shadow:0 1px 4px rgba(0,0,0,0.45)${selected ? `,0 0 0 3px ${color}55` : ''};
      transform:rotate(45deg)"></div>`,
    className: 'carrier-drop-icon',
    iconSize: [s + 4, s + 4],
    iconAnchor: [(s + 4) / 2, (s + 4) / 2],
  })
}

const FILTER_CHIPS: { key: FleetFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'vor', label: 'VOR' },
  { key: 'defects', label: 'Defects' },
  { key: 'walkaround_missing', label: 'No Check' },
  { key: 'mot_due', label: 'MOT ≤30d' },
  { key: 'caz_risk', label: 'CAZ Risk' },
  { key: 'ev', label: 'EV' },
]

// ─── main page ────────────────────────────────────────────────────────────────

export function TransportPage() {
  const { c } = useTheme()
  const wsConnected = useStore(s => s.wsConnected)
  const user = useStore(s => s.user)
  const queryClient = useQueryClient()

  // Overview opens first: it answers "what is the state of the operation" before
  // the operator has to pick which queue to look in.
  const [panelView, setPanelView] = useState<PanelView>('overview')
  const [fleetFilter, setFleetFilter] = useState<FleetFilter>('all')
  const [carrierFilter, setCarrierFilter] = useState<CarrierFilter>('delayed')
  const [search, setSearch] = useState('')
  const [selectedReg, setSelectedReg] = useState<string | null>(null)
  const [selectedMovementRef, setSelectedMovementRef] = useState<string | null>(null)
  // Selecting a leg on the map and reading its full record are two different
  // intents, so they are two different pieces of state. Selection puts the
  // action card on the map; opening details is a deliberate second step that
  // takes over the right pane with the full record — consignment, milestones,
  // outcome — and no options, because the options are on the card.
  const [movementDetailRef, setMovementDetailRef] = useState<string | null>(null)
  const [layers, setLayers] = useState<Set<MapLayer>>(new Set(['vans', 'carriers', 'caz']))
  const [liveOverrides, setLiveOverrides] = useState<Record<string, any>>({})
  const mapRef = useRef<L.Map | null>(null)

  const { data: summary } = useQuery({
    queryKey: ['fleet-summary'],
    queryFn: fetchFleetSummary,
    refetchInterval: 30_000,
  })

  const { data: fleetData } = useQuery({
    queryKey: ['fleet'],
    queryFn: () => fetchFleet(),
    refetchInterval: 30_000,
  })

  const { data: cazZones } = useQuery({ queryKey: ['caz-zones'], queryFn: fetchCazZones, staleTime: Infinity })

  const { data: routeOpt } = useQuery({
    queryKey: ['route-optimization'],
    queryFn: fetchRouteOptimization,
    refetchInterval: 60_000,
  })

  // Third-party legs out of the hubs, and the rounds projected to miss a booked
  // window. Both poll at their own feed cadence — carrier scan events land every
  // 5 minutes, ETAs are recomputed every 2 — not on the fast map interval.
  const { data: carrierData } = useQuery({
    queryKey: ['carrier-movements'],
    queryFn: () => fetchCarrierMovements(),
    refetchInterval: 60_000,
    refetchOnMount: 'always',
  })

  const { data: etaData } = useQuery({
    queryKey: ['eta-risk'],
    queryFn: () => fetchEtaRisk(),
    refetchInterval: 60_000,
    refetchOnMount: 'always',
  })

  // How many of today's appointments the late rounds are actually putting at risk.
  // Same query key and same endpoint as the Executive Dashboard and the Live
  // Visibility Hub, so all three quote one number.
  const { data: jobRisk } = useQuery({
    queryKey: ['jobs-at-risk'],
    queryFn: () => fetchJobsAtRisk(),
    refetchInterval: 20_000,
  })

  // Same query key as the Live Visibility Hub — shares the React Query cache,
  // so both pages read identical engineer/van positions.
  useQuery({
    queryKey: ['map-data'],
    queryFn: () => fetchMapData(),
    refetchInterval: 30_000,
    notifyOnChangeProps: [],
  })

  // Same WS channel as the Live Visibility Hub. Position updates are merged
  // onto fleet records by engineer_code so van locations never diverge.
  useWebSocket('visibility', useCallback((type: string, payload: any) => {
    if (type === 'engineer_location' && Array.isArray(payload)) {
      setLiveOverrides(prev => {
        const next = { ...prev }
        for (const e of payload) {
          if (e.engineer_code) {
            next[e.engineer_code] = {
              latitude: e.latitude, longitude: e.longitude,
              job_status: e.job_status, van_stock_low: e.van_stock_low,
            }
          }
        }
        return next
      })
    }
  }, []))

  const fleet = useMemo<any[]>(() => {
    const items = fleetData?.items ?? []
    return items.map((v: any) => {
      const live = liveOverrides[v.engineer_code]
      return live ? { ...v, ...live } : v
    })
  }, [fleetData, liveOverrides])

  const filtered = useMemo(() => {
    let out = fleet
    if (fleetFilter === 'vor') out = out.filter(v => v.vor)
    else if (fleetFilter === 'defects') out = out.filter(v => v.defects.some((d: any) => d.status === 'open'))
    else if (fleetFilter === 'walkaround_missing') out = out.filter(v => !v.walkaround_completed)
    else if (fleetFilter === 'mot_due') out = out.filter(v => v.mot_due_days <= 30)
    else if (fleetFilter === 'caz_risk') out = out.filter(v => !v.caz_compliant)
    else if (fleetFilter === 'ev') out = out.filter(v => v.fuel_type === 'ev')
    if (search) {
      const q = search.toLowerCase()
      out = out.filter(v =>
        v.registration.toLowerCase().includes(q) ||
        v.engineer_name.toLowerCase().includes(q) ||
        v.make_model.toLowerCase().includes(q))
    }
    return out
  }, [fleet, fleetFilter, search])

  const selected = useMemo(
    () => fleet.find(v => v.registration === selectedReg) ?? null,
    [fleet, selectedReg],
  )

  // Full route (stops) for the selected van, drawn on the map from its LIVE position
  const { data: selectedRoute, isFetched: routeFetched } = useQuery({
    queryKey: ['engineer-route', selected?.engineer_code],
    queryFn: () => fetchEngineerRoute(selected!.engineer_code),
    enabled: !!selected,
    staleTime: 30_000,
  })

  // Zoom to the van's region on selection. If it has a route today, fit the
  // map to EVERYTHING actually drawn for that van — not just the remaining
  // waypoints. Three things were getting cropped by a waypoints-only bounds
  // box: (1) roads bulge around lakes, motorways and one-way systems, so the
  // drawn road line routinely strays outside a box built from just its
  // endpoints; (2) already-completed stops (shown as grey markers) sit
  // behind the van, outside the "remaining" leg entirely; (3) incident
  // markers sit just off the line itself. Folding all of these into one
  // bounds call is what makes the zoom truly dynamic per route: a wiggly
  // cross-country route with several stops already done gets zoomed out
  // further than a tight single-stop urban hop, automatically, and nothing
  // rendered for the van ends up outside the frame. Falls back to a fixed
  // neighbourhood-level zoom around the van itself when it has no route
  // today. We wait for the route query to settle (routeFetched) before
  // moving at all — flying immediately to a van-only zoom and then
  // re-flying once the route arrives produced a jarring zoom-in-then-out
  // double animation, so we hold still and do exactly one move to the
  // final view.
  //
  // That move is instant (animate: false), not animated. We tried both
  // animation approaches and both have the same structural problem for a
  // jump this large (default fleet-wide view, zoom 6, down to a single
  // route, zoom ~9-14): fitBounds/setView's "animated zoom" CSS-scales a
  // snapshot of whatever's already on screen, so fixed-pixel-size markers
  // balloon to grotesque size while the route line — a few pixels long at
  // the zoomed-out start — stays essentially invisible until the final
  // frame snaps in. flyTo/flyToBounds recomputes real positions every
  // frame instead of faking it, but that just makes the underlying issue
  // visible rather than fixing it: at the zoomed-out intermediate frames
  // the destination route is genuinely, correctly only a few pixels
  // across, so there's nothing legible to see yet regardless of technique
  // — a few hundred milliseconds of "the detail hasn't appeared" is
  // unavoidable for any *animated* traversal of this big a zoom range.
  // The only way to skip straight to a fully rendered route view with no
  // in-between phase is to not animate the jump at all, so that's what we
  // do. Re-fires only when the selection changes or the route finishes
  // loading — not on every live position tick, so the camera doesn't
  // fight the dispatcher while a van is moving.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selected || selected.latitude == null || !routeFetched) return
    const stops = selectedRoute?.stops ?? []
    const road = selectedRoute?.road_route
    if (stops.length > 0) {
      const points: [number, number][] = [[selected.latitude, selected.longitude]]
      for (const s of stops) points.push([s.latitude, s.longitude])
      if (road?.available && road.segments?.length) {
        for (const seg of road.segments) {
          for (const coord of seg.coords) points.push(coord as [number, number])
        }
        for (const inc of road.incidents ?? []) points.push([inc.latitude, inc.longitude])
      }
      const bounds = L.latLngBounds(points)
      map.fitBounds(bounds, { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40], maxZoom: ROUTE_MAX_ZOOM, animate: false })
    } else {
      map.setView([selected.latitude, selected.longitude], VAN_ZOOM, { animate: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedReg, routeFetched])

  // Selecting a carrier leg frames the whole leg — origin hub and drop point —
  // because "where is it going from where" is the question a delayed
  // consignment raises, and a pin on the destination alone does not answer it.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedMovement || selectedMovement.latitude == null) return
    const points: [number, number][] = [[selectedMovement.latitude, selectedMovement.longitude]]
    if (selectedMovement.origin_latitude != null) {
      points.push([selectedMovement.origin_latitude, selectedMovement.origin_longitude])
    }
    map.fitBounds(L.latLngBounds(points), {
      paddingTopLeft: [60, 60], paddingBottomRight: [60, 60], maxZoom: 11, animate: false,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMovementRef])

  const clearSelectionAndRecenter = useCallback(() => {
    setSelectedReg(null)
    setSelectedMovementRef(null)
    mapRef.current?.flyTo(DEFAULT_CENTER, DEFAULT_ZOOM, { duration: 0.8 })
  }, [])

  const toggleLayer = useCallback((l: MapLayer) => {
    setLayers((prev) => {
      const n = new Set(prev)
      n.has(l) ? n.delete(l) : n.add(l)
      return n
    })
  }, [])

  const compliance = useMemo(() => ({
    walkaroundMissing: fleet.filter(v => !v.walkaround_completed),
    openDefects: fleet.filter(v => v.defects.some((d: any) => d.status === 'open')),
    motDue: [...fleet.filter(v => v.mot_due_days <= 30)].sort((a, b) => a.mot_due_days - b.mot_due_days),
  }), [fleet])

  const worstDrivers = useMemo(
    () => [...fleet].sort((a, b) => a.driver_score - b.driver_score).slice(0, 15),
    [fleet],
  )

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['fleet'] })
    queryClient.invalidateQueries({ queryKey: ['fleet-summary'] })
  }, [queryClient])

  const walkaroundMut = useMutation({
    mutationFn: (reg: string) => completeWalkaround(reg, user?.name ?? 'dispatcher'),
    onSuccess: invalidate,
  })
  const defectMut = useMutation({
    mutationFn: ({ reg, defectId }: { reg: string; defectId: string }) =>
      resolveVehicleDefect(reg, defectId, user?.name ?? 'dispatcher'),
    onSuccess: invalidate,
  })

  // Resolving a carrier delay or an arrival risk moves stock, routes and
  // appointments at once, so the whole affected surface is refetched.
  const invalidateResolutions = useCallback(() => {
    for (const key of [['carrier-movements'], ['eta-risk'], ['fleet'], ['fleet-summary'],
      ['route-optimization'], ['engineer-route'], ['map-data'], ['van-alerts'], ['locker-misses']]) {
      queryClient.invalidateQueries({ queryKey: key })
    }
  }, [queryClient])

  const carrierMut = useMutation({
    mutationFn: ({ ref, action }: { ref: string; action: string }) =>
      resolveCarrierMovement(ref, action, user?.name ?? 'dispatcher'),
    onSuccess: invalidateResolutions,
  })

  const etaMut = useMutation({
    mutationFn: ({ code, action }: { code: string; action: string }) =>
      resolveEtaRisk(code, action, user?.name ?? 'dispatcher'),
    onSuccess: invalidateResolutions,
  })

  const carrierSummary = carrierData?.summary
  const etaSummary = etaData?.summary

  // Carrier legs that can actually be drawn. A movement whose destination never
  // resolved to a coordinate is still a valid row in the list — it just cannot
  // be a pin, so it is filtered here rather than rendered at (0,0).
  const plottableMovements = useMemo<any[]>(
    () => (carrierData?.items ?? []).filter((m: any) => m.latitude != null && m.longitude != null),
    [carrierData],
  )

  // Arrival risk, indexed so a selected van can find its own without a scan.
  const etaByEngineer = useMemo<Record<string, any>>(() => {
    const m: Record<string, any> = {}
    for (const r of etaData?.items ?? []) m[r.engineer_code] = r
    return m
  }, [etaData])

  const findMovement = useCallback(
    (ref: string | null) => (ref
      ? (carrierData?.items ?? []).find((m: any) => m.movement_ref === ref) ?? null
      : null),
    [carrierData],
  )
  const selectedMovement = useMemo(() => findMovement(selectedMovementRef), [findMovement, selectedMovementRef])
  const movementDetail = useMemo(() => findMovement(movementDetailRef), [findMovement, movementDetailRef])

  // Van and carrier selection are mutually exclusive — the map shows one
  // subject at a time, and so does the panel.
  const selectVehicle = useCallback((v: any) => {
    setSelectedMovementRef(null)
    setMovementDetailRef(null)
    setSelectedReg(v.registration)
  }, [])
  const selectMovement = useCallback((ref: string) => {
    setSelectedReg(null)
    setSelectedMovementRef(ref)
    // Picking a different pin drops any detail still open for the last one,
    // rather than leaving the pane describing something the map is no longer
    // showing.
    setMovementDetailRef((cur) => (cur === ref ? cur : null))
  }, [])
  // "Show me everything about this one" — from the map card or the queue.
  const openMovementDetail = useCallback((ref: string) => {
    setSelectedReg(null)
    setSelectedMovementRef(ref)
    setMovementDetailRef(ref)
  }, [])
  const clearSelection = useCallback(() => {
    setSelectedReg(null)
    setSelectedMovementRef(null)
    setMovementDetailRef(null)
  }, [])

  const selectedEtaRisk = selected ? etaByEngineer[selected.engineer_code] : null

  // ── Workspace shell ───────────────────────────────────────────────────────
  const basemap = useBasemap()
  const { pct: panelPct, frameRef, handleProps } = useResizablePanel('clt.transport.panel', 40)
  const searchRef = useRef<HTMLInputElement | null>(null)

  // Escape is the universal "put that down" — it backs out of a carrier record,
  // then a selection, in that order, so one key unwinds the whole drill-in.
  useHotkeys({
    Escape: () => {
      if (movementDetailRef) setMovementDetailRef(null)
      else clearSelection()
    },
    '/': (e) => { e.preventDefault(); setPanelView('vehicles'); setTimeout(() => searchRef.current?.focus(), 0) },
    '1': () => setPanelView('overview'),
    '2': () => setPanelView('compliance'),
    '3': () => setPanelView('routes'),
    '4': () => setPanelView('carriers'),
    '5': () => setPanelView('vehicles'),
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: c.surface }}>

      {/* ── STATUS BAR ─────────────────────────────────────────────────────── */}
      <div className="status-bar-scroll" data-tour="tr-statusbar" style={{
        display: 'flex', alignItems: 'center', gap: 18, padding: '9px 18px',
        background: 'var(--clt-navy)', flexShrink: 0,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        {/* A connected socket is not the same claim as fresh data — the feed can
            be up while the snapshot underneath it is twenty minutes old, and
            that is exactly the state in which somebody makes a confident wrong
            decision. This states the age of the data, not the health of the
            pipe, and offers the refetch rather than making anyone reload. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {wsConnected
            ? <Wifi size={13} color={c.success.solid} aria-hidden="true" />
            : <WifiOff size={13} color={c.danger.solid} aria-hidden="true" />}
          <FreshnessMeter
            lastRefresh={summary?.last_refresh}
            connected={wsConnected}
            onRefresh={() => queryClient.invalidateQueries()}
            compactMode
          />
        </div>

        <Divider />

        {[
          { label: 'Active', val: summary?.active_vehicles ?? '—', color: BAR.success.solid },
          { label: 'En Route', val: summary?.en_route ?? '—', color: BAR.info.solid },
          { label: 'VOR', val: summary?.vor_count ?? '—', color: BAR.danger.solid },
          { label: 'Checks Done', val: summary ? `${summary.walkaround_compliance_pct}%` : '—', color: BAR.ai.solid },
          { label: 'MOT ≤30d', val: summary?.mot_due_30d ?? '—', color: BAR.warning.solid },
          { label: 'EV Fleet', val: summary ? `${summary.ev_fleet_pct}%` : '—', color: BAR.success.solid },
        ].map(({ label, val, color }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, flexShrink: 0 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
            <span style={{ color: BAR_DIM, fontSize: 11 }}>{label}</span>
            <span style={{ fontWeight: 800, color: '#fff', fontSize: 13 }}>{val}</span>
          </div>
        ))}

        {routeOpt && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, background: BAR.success.bg, borderRadius: 6, padding: '2px 8px', flexShrink: 0 }}>
            <PiggyBank size={12} color={BAR.success.text} aria-hidden="true" />
            <span style={{ color: BAR.success.text, fontWeight: 700 }}>
              £{routeOpt.fuel_saved_today_gbp} fuel · {Math.floor(routeOpt.travel_mins_saved_today / 60)}h {routeOpt.travel_mins_saved_today % 60}m saved today
            </span>
          </div>
        )}

        {(carrierSummary?.delayed ?? 0) > 0 && (
          <button
            onClick={() => { setPanelView('carriers'); setCarrierFilter('delayed'); clearSelection() }}
            title="Open the third-party carrier delay queue"
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, background: BAR.danger.bg, borderRadius: 6, padding: '2px 8px', border: `1px solid ${BAR.danger.border}`, cursor: 'pointer', flexShrink: 0 }}
          >
            <Package size={12} color={BAR.danger.text} aria-hidden="true" />
            <span style={{ color: BAR.danger.text, fontWeight: 700 }}>{carrierSummary.delayed} carrier delays</span>
            {carrierSummary.bulky_in_flight > 0 && (
              <span style={{ color: BAR_DIM, fontSize: 11 }}>· {carrierSummary.bulky_in_flight} bulky</span>
            )}
          </button>
        )}

        {(etaSummary?.engineers_late ?? 0) > 0 && (
          <button
            onClick={() => { setPanelView('routes'); clearSelection() }}
            title="Open the arrival-risk queue"
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, background: BAR.warning.bg, borderRadius: 6, padding: '2px 8px', border: `1px solid ${BAR.warning.border}`, cursor: 'pointer', flexShrink: 0 }}
          >
            <TimerOff size={12} color={BAR.warning.text} aria-hidden="true" />
            <span style={{ color: BAR.warning.text, fontWeight: 700 }}>{etaSummary.engineers_late} late</span>
            <span style={{ color: BAR_DIM, fontSize: 11 }}>
              · {etaSummary.jobs_at_risk} job{etaSummary.jobs_at_risk === 1 ? '' : 's'} at risk
            </span>
          </button>
        )}

        {(summary?.caz_non_compliant ?? 0) > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, background: BAR.warning.bg, border: `1px solid ${BAR.warning.border}`, borderRadius: 6, padding: '2px 8px', flexShrink: 0 }}>
            <ShieldAlert size={12} color={BAR.warning.text} aria-hidden="true" />
            <span style={{ color: BAR.warning.text, fontWeight: 700 }}>{summary.caz_non_compliant} CAZ non-compliant</span>
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: BAR_DIM }}>
            <Radio size={11} aria-hidden="true" />
            Avg driver score: <b style={{ color: BAR.textPrimary }}>{summary?.avg_driver_score ?? '—'}</b>
          </div>
          <StateEngineBadge />
          {/* Shortcuts nobody can discover are shortcuts nobody uses. */}
          <ShortcutHint items={[
            ['Esc', 'Close the open record, then the selection'],
            ['/', 'Search the van list'],
            ['1 – 5', 'Jump to a panel section'],
            ['← →', 'Move between sections (from a tab)'],
            ['?', 'Show or hide this list'],
          ]} />
        </div>
      </div>

      {/* ── BODY: MAP + PANEL ─────────────────────────────────────────────── */}
      {/* The split is the operator's: reading a carrier consignment and watching
          a region spread across the map want opposite proportions, and the
          divider remembers where it was left. */}
      <div ref={frameRef} style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0, position: 'relative' }}>

        {/* ── MAP ────────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>

          {/* Legend */}
          <div style={{
            position: 'absolute', bottom: 30, left: 12, zIndex: 500,
            background: 'rgba(10,16,32,0.82)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
            borderRadius: 10, padding: '10px 13px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
            fontSize: 11, display: 'flex', flexDirection: 'column', gap: 5,
          }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.35)', marginBottom: 2 }}>Vans</div>
            {(['available', 'en_route', 'on_site'] as const).map(k => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'rgba(255,255,255,0.7)' }}>
                <div style={{ width: 9, height: 9, borderRadius: '50%', background: vanTone(c, k).solid, flexShrink: 0 }} />
                {STATUS_LABEL[k]}
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'rgba(255,255,255,0.6)' }}>
              <div style={{ width: 9, height: 9, borderRadius: '50%', border: '2px solid #EF4444', background: 'transparent', flexShrink: 0 }} />
              VOR / open defect
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'rgba(255,255,255,0.6)' }}>
              <div style={{ width: 9, height: 9, borderRadius: '50%', border: '2px dashed #F97316', background: 'transparent', flexShrink: 0 }} />
              Arrival at risk
            </div>
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 5, marginTop: 2, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.35)' }}>
                Carrier drops
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'rgba(255,255,255,0.6)' }}>
                <div style={{ width: 8, height: 8, background: '#3B82F6', border: '1.5px solid #fff', borderRadius: 2, transform: 'rotate(45deg)', flexShrink: 0 }} />
                In transit / booked
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'rgba(255,255,255,0.6)' }}>
                <div style={{ width: 8, height: 8, background: '#EF4444', border: '1.5px solid #fff', borderRadius: 2, transform: 'rotate(45deg)', flexShrink: 0 }} />
                Running late
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'rgba(255,255,255,0.6)' }}>
                <div style={{ width: 11, height: 11, background: '#94A3B8', border: '1.5px solid #fff', borderRadius: 1.5, transform: 'rotate(45deg)', flexShrink: 0 }} />
                Two-man bulky (larger)
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'rgba(255,255,255,0.6)' }}>
              <div style={{ width: 9, height: 9, borderRadius: '50%', background: '#8B5CF630', border: '1px solid #8B5CF6', flexShrink: 0 }} />
              Clean Air Zone
            </div>
          </div>

          {/* Layer toggles — three layers now compete for the same map, so the
              dispatcher gets to decide which. */}
          <div style={{
            position: 'absolute', top: 12, left: 12, zIndex: 500,
            background: 'rgba(8,13,28,0.93)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
            borderRadius: 10, padding: '8px 10px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.12)',
            display: 'flex', gap: 5,
          }}>
            <span style={{
              fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em',
              color: 'rgba(255,255,255,0.35)', alignSelf: 'center', paddingRight: 6,
              borderRight: '1px solid rgba(255,255,255,0.12)', marginRight: 2,
            }}>
              Layers
            </span>
            {([
              { key: 'vans', icon: Truck, label: `Vans (${filtered.length})` },
              { key: 'carriers', icon: Package, label: `Carriers (${plottableMovements.length})` },
              { key: 'caz', icon: ShieldAlert, label: 'CAZ' },
            ] as { key: MapLayer; icon: React.ElementType; label: string }[]).map(({ key, icon: Icon, label }) => (
              <button key={key} onClick={() => toggleLayer(key)} style={{
                padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                border: layers.has(key) ? '1px solid rgba(251,78,11,0.7)' : '1px solid rgba(255,255,255,0.12)',
                cursor: 'pointer',
                background: layers.has(key) ? 'rgba(251,78,11,0.85)' : 'rgba(255,255,255,0.06)',
                color: layers.has(key) ? '#fff' : 'rgba(255,255,255,0.55)',
                transition: 'all 150ms', display: 'flex', alignItems: 'center', gap: 5,
              }}>
                <Icon size={12} strokeWidth={1.8} />{label}
              </button>
            ))}
          </div>

          {/* Traffic legend + live route info — only while a route is drawn */}
          {selected && selectedRoute?.road_route?.available && (
            <div style={{
              position: 'absolute', top: 56, left: 12, zIndex: 500,
              background: 'rgba(10,16,32,0.88)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
              borderRadius: 10, padding: '10px 13px',
              boxShadow: '0 4px 24px rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
              fontSize: 11, display: 'flex', flexDirection: 'column', gap: 5, maxWidth: 230,
            }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.35)' }}>
                Live Route · {selected.registration}
              </div>
              <div style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>
                {selectedRoute.road_route.distance_miles} mi by road · {selectedRoute.road_route.base_duration_mins} min
                {selectedRoute.road_route.traffic_delay_mins > 0 && (
                  <span style={{ color: 'var(--status-warning-text)' }}> +{selectedRoute.road_route.traffic_delay_mins} min traffic</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                {Object.keys(CONGESTION_TONE).map((k) => (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'rgba(255,255,255,0.65)', textTransform: 'capitalize', fontSize: 11 }}>
                    <div style={{ width: 14, height: 4, borderRadius: 2, background: congestionColor(c, k) }} />
                    {k}
                  </div>
                ))}
              </div>
              {selectedRoute.road_route.incidents.length > 0 && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {selectedRoute.road_route.incidents.map((inc: any, i: number) => (
                    <div key={i} style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, display: 'flex', gap: 5 }}>
                      <span>{inc.icon}</span>
                      <span style={{ flex: 1 }}>{inc.description}</span>
                      {inc.delay_mins > 0 && <b style={{ color: 'var(--status-warning-text)' }}>+{inc.delay_mins}m</b>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Filter result badge — centred, because the top-right corner now
              belongs to the action card. */}
          {(fleetFilter !== 'all' || search) && (
            <div style={{
              position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 500,
              background: 'var(--clt-navy)', color: '#fff', borderRadius: 20,
              padding: '4px 12px', fontSize: 11, fontWeight: 700,
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            }}>
              {filtered.length} / {fleet.length} vans
            </div>
          )}

          {/* ── Action card ──────────────────────────────────────────────────
              Clicking something on a map is asking "what about this one?" —
              and for a van running late or a consignment running behind, the
              answer is a decision, not a description. The options travel with
              the subject to wherever it was selected, so a dispatcher working
              geographically never has to go and find the list to act. */}
          {selectedEtaRisk && selectedEtaRisk.status === 'open' && (
            <MapActionCard
              tone={SEVERITY_COLOR[selectedEtaRisk.severity] ?? '#F59E0B'}
              icon={<TimerOff size={13} />}
              title={selectedEtaRisk.engineer_name}
              subtitle={`${selectedEtaRisk.registration ?? selectedEtaRisk.engineer_code} · ${selectedEtaRisk.cause_label}`}
              badge={`+${fmtDelay(selectedEtaRisk.delay_mins)} behind`}
              onClose={clearSelection}
              summary={
                <>
                  <b>{selectedEtaRisk.jobs_at_risk}</b> appointment{selectedEtaRisk.jobs_at_risk === 1 ? '' : 's'} project past
                  {' '}their window, worst by <b>{selectedEtaRisk.worst_breach_mins} min</b>
                  {selectedEtaRisk.sla_jobs_at_risk > 0 && <> · <b>{selectedEtaRisk.sla_jobs_at_risk}</b> carry an SLA</>}.
                </>
              }
              options={selectedEtaRisk.options ?? []}
              onApply={(action) => etaMut.mutate({ code: selectedEtaRisk.engineer_code, action })}
              pending={etaMut.isPending ? (etaMut.variables as any)?.action : null}
              error={(etaMut.data as any)?.error}
            />
          )}

          {selectedMovement && (
            <MapActionCard
              tone={movementTone(c, selectedMovement.status, (selectedMovement.delay_mins ?? 0) > 0).solid}
              icon={<Package size={13} />}
              title={selectedMovement.movement_ref}
              subtitle={`${selectedMovement.carrier} · ${selectedMovement.service_label}`}
              badge={(selectedMovement.delay_mins ?? 0) > 0
                ? `+${fmtDelay(selectedMovement.delay_mins)} late`
                : selectedMovement.status.replace(/_/g, ' ')}
              onClose={clearSelection}
              summary={
                <>
                  <b>{selectedMovement.origin_name}</b> → {selectedMovement.dest_name}
                  {' · '}{selectedMovement.pieces} pc{selectedMovement.is_bulky ? ' · two-man bulky' : ''}
                  {' · ETA '}<b>{fmtEta(selectedMovement.eta)}</b>
                </>
              }
              options={selectedMovement.options ?? []}
              emptyNote={selectedMovement.resolution
                ? `Worked already — ${selectedMovement.resolution.summary}`
                : 'Running to promise — nothing to decide.'}
              onApply={(action) => carrierMut.mutate({ ref: selectedMovement.movement_ref, action })}
              pending={carrierMut.isPending ? (carrierMut.variables as any)?.action : null}
              error={(carrierMut.data as any)?.error}
              onOpenDetails={movementDetailRef === selectedMovement.movement_ref
                ? undefined
                : () => openMovementDetail(selectedMovement.movement_ref)}
            />
          )}

          {/* Recenter CTA — only relevant once the map has zoomed to something */}
          {(selected || selectedMovement) && (
            <button
              onClick={clearSelectionAndRecenter}
              title="Clear the selection and restore the default fleet-wide view"
              style={{
                position: 'absolute', bottom: 90, right: 12, zIndex: 500,
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'rgba(10,16,32,0.88)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
                border: '1px solid rgba(255,255,255,0.14)', borderRadius: 20,
                padding: '7px 13px', fontSize: 11, fontWeight: 700, color: '#fff',
                boxShadow: '0 4px 24px rgba(0,0,0,0.3)', cursor: 'pointer',
              }}
            >
              <XCircle size={13} /> Clear Selection
            </button>
          )}

          <MapContainer
            ref={mapRef}
            center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM}
            style={{ height: '100%', width: '100%' }}
            zoomControl={false}
          >
            <ZoomControl position="bottomright" />
            {/* The basemap follows the theme. A dispatcher on the dark console
                at 3am was previously handed a floodlit white map; `key` forces
                Leaflet to swap the layer outright rather than cross-fade two
                rasters when the theme changes. */}
            <TileLayer key={basemap.key} url={basemap.url} attribution={basemap.attribution} />

            {/* Clean Air Zones */}
            {layers.has('caz') && (cazZones ?? []).map((z: any) => (
              <Circle
                key={z.name}
                center={[z.latitude, z.longitude]}
                radius={z.radius_km * 1000}
                pathOptions={{ fillColor: c.ai.solid, fillOpacity: basemap.isDark ? 0.16 : 0.10, color: c.ai.solid, weight: 1.5, dashArray: '4 4' }}
              >
                <Popup>
                  <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                    <b>{z.name}</b> ({z.class})<br />
                    Vans charged: {z.charges_vans ? `£${z.daily_charge_gbp.toFixed(2)}/day` : 'No'}<br />
                    Operating: {z.hours}
                  </div>
                </Popup>
              </Circle>
            ))}

            {/* Selected van's route — road-following geometry from the LIVE van position */}
            {selected && selectedRoute?.stops && selected.latitude != null && (() => {
              // Blocked stops are booked on this round but the van is not going
              // to them — no accreditation — so they are drawn as pins without
              // ever joining the route line.
              const remaining = selectedRoute.stops.filter((s: any) => s.status !== 'completed' && s.status !== 'blocked')
              const completed = selectedRoute.stops.filter((s: any) => s.status === 'completed')
              const blocked = selectedRoute.stops.filter((s: any) => s.status === 'blocked')
              const road = selectedRoute.road_route
              const fallbackLine: [number, number][] = [
                [selected.latitude, selected.longitude],
                ...remaining.map((s: any) => [s.latitude, s.longitude] as [number, number]),
              ]
              return (
                <>
                  {road?.available ? (
                    <>
                      {/* road casing for contrast, then congestion-coloured segments */}
                      {road.segments.map((seg: any, i: number) => (
                        <Polyline key={`casing-${i}`} positions={seg.coords} pathOptions={{ color: basemap.isDark ? '#000' : '#1E293B', weight: 7, opacity: basemap.isDark ? 0.55 : 0.35 }} />
                      ))}
                      {road.segments.map((seg: any, i: number) => (
                        <Polyline key={`seg-${i}`} positions={seg.coords} pathOptions={{ color: congestionColor(c, seg.congestion), weight: 4, opacity: 0.95 }}>
                          <Popup>
                            <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                              Traffic: <b style={{ color: toneOf(c, CONGESTION_TONE[seg.congestion] ?? 'neutral').text, textTransform: 'capitalize' }}>{seg.congestion === 'free' ? 'Free flowing' : seg.congestion}</b>
                            </div>
                          </Popup>
                        </Polyline>
                      ))}
                      {/* incidents / navigation warnings */}
                      {road.incidents.map((inc: any, i: number) => (
                        <Marker key={`inc-${i}`} position={[inc.latitude, inc.longitude]} icon={incidentIcon(inc.icon)}>
                          <Popup>
                            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                              <b>{inc.icon} {inc.description}</b><br />
                              {inc.delay_mins > 0
                                ? <span style={{ color: 'var(--status-danger-text)', fontWeight: 700 }}>+{inc.delay_mins} min delay</span>
                                : <span style={{ color: 'var(--clt-grey-500)' }}>No delay — drive to limit</span>}
                            </div>
                          </Popup>
                        </Marker>
                      ))}
                    </>
                  ) : (
                    // routing service unreachable — indicative straight-line fallback
                    <Polyline positions={fallbackLine} pathOptions={{ color: c.info.solid, weight: 3, opacity: 0.8, dashArray: '8 6' }} />
                  )}
                  {[...completed, ...remaining, ...blocked].map((s: any) => {
                    // A parts-collection stop is not a job — it is the detour a
                    // van-stock resolution inserted — so it is drawn distinctly.
                    const isCollection = s.stop_kind === 'collection'
                    const isBlocked = s.status === 'blocked'
                    const color = isBlocked ? '#F59E0B' : isCollection ? '#8B5CF6'
                      : s.status === 'completed' ? '#94A3B8' : s.status === 'next' ? '#F97316' : '#3B82F6'
                    return (
                      <CircleMarker
                        key={s.job_code}
                        center={[s.latitude, s.longitude]}
                        radius={isCollection ? 10 : 9}
                        pathOptions={{
                          fillColor: color, fillOpacity: s.status === 'completed' ? 0.5 : 0.95,
                          color: '#fff', weight: 2, dashArray: isCollection ? '3 3' : undefined,
                        }}
                      >
                        <LTooltip permanent direction="center" className="route-stop-label">
                          <span style={{ fontSize: 11, fontWeight: 800, color: '#fff' }}>{isBlocked ? '!' : s.seq}</span>
                        </LTooltip>
                        <Popup>
                          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                            {isBlocked ? (
                              <>
                                <b>{s.job_code} · cannot be sequenced</b><br />
                                {s.job_type.replace(/_/g, ' ')} · {s.postcode}<br />
                                Booked for {s.booked_arrival}, window to {s.sla_deadline}<br />
                                <span style={{ color, fontWeight: 700 }}>
                                  Engineer lacks {(s.missing_skill_labels ?? []).join(', ')}
                                </span><br />
                                Reallocate to an accredited engineer.
                              </>
                            ) : isCollection ? (
                              <>
                                <b>Stop {s.seq} · Parts collection</b><br />
                                {s.collection_site_name} ({s.collection_kind}) · {s.postcode}<br />
                                Collecting: {(s.sku_codes ?? []).join(', ')}<br />
                                ETA {s.planned_arrival} · {s.service_mins} min<br />
                                <span style={{ color, fontWeight: 700 }}>Added by {s.added_by}</span>
                              </>
                            ) : (
                              <>
                                <b>Stop {s.seq} · {s.job_code}</b><br />
                                {s.job_type.replace(/_/g, ' ')} · {s.postcode}<br />
                                ETA {s.planned_arrival} · {s.service_mins} min on site
                                {s.sla_deadline ? <> · window to {s.sla_deadline}</> : null}<br />
                                <span style={{ color, fontWeight: 700, textTransform: 'capitalize' }}>{s.status}</span>
                              </>
                            )}
                          </div>
                        </Popup>
                      </CircleMarker>
                    )
                  })}
                </>
              )
            })()}

            {/* ── Third-party carrier legs ────────────────────────────────
                Drawn at the DROP point, not the vehicle: we do not have live
                telemetry on somebody else's van, and pretending we do would be
                inventing a position. What we know is where it is going, when it
                was promised and what the carrier last scanned — so the pin is
                the destination and the line is the leg. */}
            {layers.has('carriers') && plottableMovements.map((m: any) => {
              const isSel = selectedMovementRef === m.movement_ref
              const late = (m.delay_mins ?? 0) > 0 && m.status !== 'delivered'
              const color = movementTone(c, m.status, late).solid
              return (
                <Marker
                  key={m.movement_ref}
                  position={[m.latitude, m.longitude]}
                  icon={carrierIcon(color, m.is_bulky, isSel)}
                  zIndexOffset={isSel ? 1000 : late ? 500 : 0}
                  eventHandlers={{ click: () => selectMovement(m.movement_ref) }}
                >
                  <LTooltip direction="top" offset={[0, -10]}>
                    <span style={{ fontSize: 11, fontWeight: 700 }}>
                      {m.movement_ref} · {DEST_META[m.dest_type]?.label ?? m.dest_type}
                      {late ? ` · +${fmtDelay(m.delay_mins)} late` : ''}
                    </span>
                  </LTooltip>
                </Marker>
              )
            })}

            {/* The selected leg, hub → drop point. Dashed because it is a
                third-party movement, not a road route we hold geometry for. */}
            {selectedMovement && selectedMovement.latitude != null
              && selectedMovement.origin_latitude != null && (
              <>
                <Polyline
                  positions={[
                    [selectedMovement.origin_latitude, selectedMovement.origin_longitude],
                    [selectedMovement.latitude, selectedMovement.longitude],
                  ]}
                  pathOptions={{
                    color: (selectedMovement.delay_mins ?? 0) > 0 ? '#EF4444' : '#3B82F6',
                    weight: 3, opacity: 0.85, dashArray: '9 7',
                  }}
                />
                <CircleMarker
                  center={[selectedMovement.origin_latitude, selectedMovement.origin_longitude]}
                  radius={9}
                  pathOptions={{ fillColor: '#0F3460', fillOpacity: 0.9, color: '#fff', weight: 2 }}
                >
                  <Popup>
                    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                      <b>{selectedMovement.origin_name}</b><br />
                      Origin hub for {selectedMovement.movement_ref}
                    </div>
                  </Popup>
                </CircleMarker>
              </>
            )}

            {/* Van markers — positions identical to Live Visibility Hub */}
            {layers.has('vans') && filtered.map((v: any) => {
              if (v.latitude == null) return null
              const isSelected = selectedReg === v.registration
              const hasIssue = v.vor || v.defects.some((d: any) => d.status === 'open')
              // A van about to miss a booked window is worth spotting from the
              // map, not only from the list — so arrival risk gets a ring of its
              // own, dashed to stay distinguishable from the VOR ring.
              const risk = etaByEngineer[v.engineer_code]
              const atRisk = risk && risk.status === 'open'
              return (
                <CircleMarker
                  key={v.registration}
                  center={[v.latitude, v.longitude]}
                  radius={isSelected ? 8 : atRisk ? 6 : 5}
                  pathOptions={{
                    fillColor: vanTone(c, v.job_status).solid,
                    fillOpacity: isSelected ? 1 : 0.82,
                    color: hasIssue ? c.danger.solid : atRisk ? c.warning.solid : isSelected ? c.accentSolid : 'transparent',
                    weight: hasIssue || atRisk ? 2 : isSelected ? 2 : 0,
                    dashArray: atRisk && !hasIssue ? '3 2' : undefined,
                  }}
                  eventHandlers={{ click: () => selectVehicle(v) }}
                >
                  <Popup>
                    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                      <b>{v.registration}</b> · {v.make_model}<br />
                      {v.engineer_name} · {v.region}<br />
                      <span style={{ color: vanTone(c, v.job_status).text, fontWeight: 700 }}>{STATUS_LABEL[v.job_status] || v.job_status}</span>
                      {v.vor && <> · <span style={{ color: 'var(--status-danger-text)', fontWeight: 700 }}>VOR</span></>}
                      {atRisk && (
                        <> · <span style={{ color: 'var(--accent-text)', fontWeight: 700 }}>
                          +{fmtDelay(risk.delay_mins)} behind, {risk.jobs_at_risk} at risk
                        </span></>
                      )}
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
          {movementDetail ? (
            <CarrierDetail
              mv={movementDetail}
              onBack={() => setMovementDetailRef(null)}
              onSelectEngineer={(code: string) => {
                const van = fleet.find((v: any) => v.engineer_code === code)
                if (van) selectVehicle(van)
              }}
            />
          ) : selected ? (
            <VehicleDetail
              v={selected}
              route={selectedRoute}
              onBack={clearSelection}
              onWalkaround={() => walkaroundMut.mutate(selected.registration)}
              onResolveDefect={(defectId: string) => defectMut.mutate({ reg: selected.registration, defectId })}
              walkaroundPending={walkaroundMut.isPending}
              etaRisk={selectedEtaRisk}
            />
          ) : (
            <>
              <PanelTabs
                idPrefix="transport"
                active={panelView}
                onChange={setPanelView}
                tabs={[
                  { key: 'overview', label: 'Overview' },
                  { key: 'compliance', label: 'Compliance' },
                  { key: 'routes', label: 'Routes', count: etaSummary?.engineers_late ?? 0 },
                  { key: 'carriers', label: 'Carriers', count: carrierSummary?.delayed ?? 0 },
                  { key: 'vehicles', label: `Vans (${filtered.length})` },
                ]}
              />

              <div
                role="tabpanel"
                id={`transport-panel-${panelView}`}
                aria-labelledby={`transport-tab-${panelView}`}
                tabIndex={0}
                style={{ flex: 1, overflowY: 'auto', padding: 14 }}
              >
                {panelView === 'overview' && (
                  <OverviewPanel
                    summary={summary}
                    etaSummary={etaSummary}
                    carrierSummary={carrierSummary}
                    worstDrivers={worstDrivers}
                    onSelect={selectVehicle}
                    onGoTo={setPanelView}
                    onGoToFleet={(f: FleetFilter) => { setFleetFilter(f); setPanelView('vehicles') }}
                    onGoToCarriers={(f: CarrierFilter) => { setCarrierFilter(f); setPanelView('carriers') }}
                  />
                )}
                {panelView === 'compliance' && (
                  <CompliancePanel
                    compliance={compliance}
                    summary={summary}
                    onSelect={selectVehicle}
                    onWalkaround={(reg: string) => walkaroundMut.mutate(reg)}
                  />
                )}
                {panelView === 'routes' && (
                  <RoutesPanel
                    routeOpt={routeOpt} fleet={fleet} onSelect={selectVehicle}
                    etaData={etaData} jobRisk={jobRisk}
                    onResolveEta={(code: string, action: string) => etaMut.mutate({ code, action })}
                    pendingEtaCode={etaMut.isPending ? (etaMut.variables as any)?.code : null}
                    pendingEtaAction={etaMut.isPending ? (etaMut.variables as any)?.action : null}
                    etaError={(etaMut.data as any)?.error}
                  />
                )}
                {panelView === 'carriers' && (
                  <CarriersPanel
                    data={carrierData}
                    filter={carrierFilter} setFilter={setCarrierFilter}
                    onResolve={(ref: string, action: string) => carrierMut.mutate({ ref, action })}
                    pendingRef={carrierMut.isPending ? (carrierMut.variables as any)?.ref : null}
                    pendingAction={carrierMut.isPending ? (carrierMut.variables as any)?.action : null}
                    error={(carrierMut.data as any)?.error}
                    onOpenDetails={openMovementDetail}
                    onSelectEngineer={(code: string) => {
                      const van = fleet.find((v: any) => v.engineer_code === code)
                      if (van) selectVehicle(van)
                    }}
                  />
                )}
                {panelView === 'vehicles' && (
                  <VehiclesPanel
                    vehicles={filtered} allCount={fleet.length}
                    search={search} setSearch={setSearch}
                    filter={fleetFilter} setFilter={setFleetFilter}
                    onSelect={selectVehicle}
                    searchRef={searchRef}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Driver score → the theme's ink for that band. Text, so the `.text` step. */
function scoreColor(c: AppColors, score: number) {
  return (score >= 85 ? c.success : score >= 70 ? c.warning : c.danger).text
}

// ─── Map action card ─────────────────────────────────────────────────────────
// The decision, next to the thing it is about.
//
// A dispatcher working the map is reasoning geographically — "that one, near
// there, is in trouble". Sending them to a list to act on it breaks the thread
// and loses the spatial context that made them click in the first place. So the
// same priced options the list shows travel to the map.
//
// It is a light surface rather than the dark glass the read-only map panels use,
// deliberately: those panels are legends, this one holds controls you press, and
// it should read as a card sitting ON the map rather than an overlay drawn over
// it.

function MapActionCard({
  tone, icon, title, subtitle, badge, summary, options, onApply, pending, error, onClose,
  emptyNote, onOpenDetails,
}: {
  tone: string
  icon: React.ReactNode
  title: string
  subtitle: string
  badge: string
  summary: React.ReactNode
  options: any[]
  onApply: (action: string) => void
  pending: string | null
  error?: string
  onClose: () => void
  emptyNote?: string
  /** Opens the full record in the right pane. Omitted when it is already open. */
  onOpenDetails?: () => void
}) {
  const { c } = useTheme()
  const actionable = (options ?? []).filter((o) => o.available)

  return (
    <div style={{
      position: 'absolute', top: 12, right: 12, zIndex: 600,
      width: 350, maxHeight: 'calc(100% - 120px)',
      display: 'flex', flexDirection: 'column',
      background: c.surface, border: `1px solid ${c.border}`, borderRadius: 11,
      boxShadow: '0 14px 40px rgba(0,0,0,0.28)', overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 12px', background: tone + '12', borderBottom: `1px solid ${tone}33`,
        display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0,
      }}>
        <span style={{ color: tone, display: 'flex', marginTop: 2, flexShrink: 0 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: c.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </div>
          <div style={{ fontSize: 11, color: c.textMuted, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {subtitle}
          </div>
        </div>
        <span style={{
          fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
          padding: '2px 7px', borderRadius: 4, background: tone + '1e', color: tone,
          border: `1px solid ${tone}44`, whiteSpace: 'nowrap', flexShrink: 0,
        }}>
          {badge}
        </span>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: c.textMuted, padding: 0, display: 'flex', flexShrink: 0 }}
        >
          <XCircle size={14} />
        </button>
      </div>

      <div style={{ padding: '10px 12px', overflowY: 'auto' }}>
        <div style={{ fontSize: 11, color: c.textSecondary, lineHeight: 1.55, marginBottom: 8 }}>
          {summary}
        </div>

        {onOpenDetails && (
          <button
            onClick={onOpenDetails}
            style={{
              width: '100%', marginBottom: 10, padding: '6px 10px', borderRadius: 6,
              fontSize: 11, fontWeight: 700, cursor: 'pointer',
              background: c.surfaceSubtle, color: c.textSecondary, border: `1px solid ${c.border}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            }}
          >
            Full details — consignment & tracking <ChevronRight size={12} />
          </button>
        )}

        {error && (
          <div style={{
            fontSize: 11, color: c.danger.text, background: c.danger.bg,
            border: `1px solid ${c.danger.border}`, borderRadius: 6, padding: '6px 9px', marginBottom: 9,
          }}>
            {error}
          </div>
        )}

        {actionable.length > 0 ? (
          <>
            <div style={{
              fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em',
              color: c.textMuted, marginBottom: 7,
            }}>
              {actionable.length} option{actionable.length === 1 ? '' : 's'} available
            </div>
            <OptionList options={options} onApply={onApply} pending={pending} />
          </>
        ) : (
          <div style={{ fontSize: 11, color: c.textSecondary, lineHeight: 1.5 }}>
            {emptyNote ?? 'No option is available in the current state.'}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Compliance panel ────────────────────────────────────────────────────────

function CompliancePanel({ compliance, summary, onSelect, onWalkaround }: any) {
  const { c } = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* Compliance scorecard */}
      <div>
        <SectionLabel>DVSA Compliance Today</SectionLabel>
        <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', marginBottom: 10, lineHeight: 1.6 }}>
          Daily legal readiness of the van fleet — hover any measure for what it
          means and the DVSA expectation behind it.
        </div>
        <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px' } as React.CSSProperties}>
          {[
            { label: 'Walkaround Done', info: 'Walkaround Compliance', val: summary ? `${summary.walkaround_compliance_pct}%` : '—', color: (summary?.walkaround_compliance_pct ?? 100) >= 95 ? '#10B981' : '#F59E0B', icon: <ClipboardCheck size={14} /> },
            { label: 'Open Defects', info: 'Open Defects', val: summary?.open_defects ?? '—', color: (summary?.open_defects ?? 0) > 0 ? '#EF4444' : '#10B981', icon: <Wrench size={14} /> },
            { label: 'Vehicles Off Road', info: 'VOR', val: summary?.vor_count ?? '—', color: (summary?.vor_count ?? 0) > 0 ? '#EF4444' : '#10B981', icon: <AlertTriangle size={14} /> },
            { label: 'CAZ Charge Exposure', info: 'CAZ Non-Compliant', val: summary?.caz_non_compliant ?? '—', color: (summary?.caz_non_compliant ?? 0) > 0 ? '#F97316' : '#10B981', icon: <ShieldAlert size={14} /> },
          ].map(({ label, info, val, color, icon }) => (
            <MetricTip key={label} label={info} title={label} block>
              <div style={{
                background: color + '12', border: `1px solid ${color}2e`,
                borderRadius: 8, padding: '11px 13px',
              }}>
                <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ color }}>{icon}</span>{label}
                </div>
                <div style={{ fontSize: 24, fontWeight: 900, color, lineHeight: 1 }}>{val}</div>
              </div>
            </MetricTip>
          ))}
        </div>
      </div>

      {/* Walkaround checks missing */}
      <div>
        <SectionLabel>Walkaround Checks Missing ({compliance.walkaroundMissing.length})</SectionLabel>
        {compliance.walkaroundMissing.length === 0 ? (
          <EmptyNote>All daily checks completed ✅</EmptyNote>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {compliance.walkaroundMissing.slice(0, 8).map((v: any) => (
              <div key={v.registration} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                background: '#8B5CF610', border: '1px solid #8B5CF630', borderRadius: 7,
              }}>
                <button onClick={() => onSelect(v)} style={{ flex: 1, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary }}>{v.registration}</div>
                  <div style={{ fontSize: 11, color: 'var(--clt-grey-400)' }}>{v.engineer_name} · {v.region}</div>
                </button>
                <button onClick={() => onWalkaround(v.registration)} style={{
                  fontSize: 11, fontWeight: 700, padding: '5px 12px', borderRadius: 6,
                  border: 'none', background: '#8B5CF6', color: '#fff', cursor: 'pointer',
                }}>
                  Sign Off
                </button>
              </div>
            ))}
            {compliance.walkaroundMissing.length > 8 && (
              <MoreNote n={compliance.walkaroundMissing.length - 8} />
            )}
          </div>
        )}
      </div>

      {/* Open defects */}
      <div>
        <SectionLabel>Open Defects ({compliance.openDefects.length} vehicles)</SectionLabel>
        {compliance.openDefects.length === 0 ? (
          <EmptyNote>No open defects 🎉</EmptyNote>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {compliance.openDefects.slice(0, 8).map((v: any) => {
              const open = v.defects.filter((d: any) => d.status === 'open')
              const hasMajor = open.some((d: any) => d.severity === 'major')
              return (
                <button key={v.registration} onClick={() => onSelect(v)} style={{
                  display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 10px', width: '100%',
                  background: hasMajor ? '#FEF2F2' : 'var(--clt-grey-50)',
                  border: `1px solid ${hasMajor ? '#FCA5A5' : 'var(--clt-grey-200)'}`,
                  borderRadius: 7, cursor: 'pointer', textAlign: 'left',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary }}>{v.registration}</span>
                    {v.vor && <span style={{ fontSize: 11, fontWeight: 800, background: '#EF4444', color: '#fff', borderRadius: 4, padding: '1px 6px' }}>VOR</span>}
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--clt-grey-400)' }}>{open.length} open</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--clt-grey-500)' }}>{open[0]?.description}</div>
                </button>
              )
            })}
            {compliance.openDefects.length > 8 && <MoreNote n={compliance.openDefects.length - 8} />}
          </div>
        )}
      </div>

      {/* MOT due */}
      <div>
        <SectionLabel>MOT Due ≤ 30 Days ({compliance.motDue.length})</SectionLabel>
        {compliance.motDue.length === 0 ? (
          <EmptyNote>No MOTs due in the next 30 days</EmptyNote>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {compliance.motDue.slice(0, 8).map((v: any) => (
              <button key={v.registration} onClick={() => onSelect(v)} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', width: '100%',
                background: v.mot_due_days <= 7 ? '#FEF2F2' : 'var(--clt-grey-50)',
                border: `1px solid ${v.mot_due_days <= 7 ? '#FCA5A5' : 'var(--clt-grey-200)'}`,
                borderRadius: 7, cursor: 'pointer', textAlign: 'left',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary }}>{v.registration}</div>
                  <div style={{ fontSize: 11, color: 'var(--clt-grey-400)' }}>{v.make_model}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: v.mot_due_days <= 7 ? '#EF4444' : '#F59E0B' }}>{v.mot_due_days}d</div>
                  <div style={{ fontSize: 11, color: 'var(--clt-grey-400)' }}>{v.mot_due_date}</div>
                </div>
              </button>
            ))}
            {compliance.motDue.length > 8 && <MoreNote n={compliance.motDue.length - 8} />}
          </div>
        )}
      </div>
    </div>
  )
}

function MoreNote({ n }: { n: number }) {
  return (
    <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', textAlign: 'center', padding: '4px 0' }}>
      + {n} more — use the Vehicles tab to see all
    </div>
  )
}

// ─── Routes panel ────────────────────────────────────────────────────────────

function RoutesPanel({
  routeOpt, fleet, onSelect, etaData, jobRisk, onResolveEta, pendingEtaCode, pendingEtaAction, etaError,
}: any) {
  const { c } = useTheme()
  const byEngineer = useMemo(() => {
    const m: Record<string, any> = {}
    for (const v of fleet) m[v.engineer_code] = v
    return m
  }, [fleet])

  const risks: any[] = etaData?.items ?? []
  const openRisks = risks.filter(r => r.status === 'open')
  const resolvedRisks = risks.filter(r => r.status === 'resolved')
  const s = etaData?.summary

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* Savings scorecard */}
      <div>
        <SectionLabel>Route Optimization — Today</SectionLabel>
        {/* A round that has been actioned goes straight back into live traffic —
            its delay stops being proof that anybody did anything. This is the
            proof: today's arrival-risk decisions, counted off the audit trail,
            and a way into the entries themselves. */}
        <ActionedToday module="/transport" section="Arrival Risk" label="round" />
        <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px' } as React.CSSProperties}>
          {[
            { label: 'Travel Time Saved', val: routeOpt ? `${Math.floor(routeOpt.travel_mins_saved_today / 60)}h ${routeOpt.travel_mins_saved_today % 60}m` : '—', color: c.info.text, icon: <RouteIcon size={14} /> },
            { label: 'Miles Avoided', val: routeOpt ? `${routeOpt.miles_saved_today}` : '—', color: c.ai.text, icon: <Gauge size={14} /> },
            { label: 'Fuel Saved', val: routeOpt ? `£${routeOpt.fuel_saved_today_gbp}` : '—', color: c.success.text, icon: <PiggyBank size={14} /> },
            { label: 'CO₂ Avoided', val: routeOpt ? `${routeOpt.co2_saved_today_kg} kg` : '—', color: c.success.text, icon: <Zap size={14} /> },
          ].map(({ label, val, color, icon }) => (
            <MetricTip key={label} label={label} block>
              <div style={{
                background: color + '12', border: `1px solid ${color}2e`,
                borderRadius: 8, padding: '11px 13px',
              }}>
                <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ color }}>{icon}</span>{label}
                </div>
                <div style={{ fontSize: 20, fontWeight: 900, color, lineHeight: 1 }}>{val}</div>
              </div>
            </MetricTip>
          ))}
        </div>
        {routeOpt && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--clt-grey-500)', background: 'var(--clt-grey-50)', borderRadius: 7, padding: '8px 11px', lineHeight: 1.6 }}>
            <b>{routeOpt.routes_optimized}</b> of <b>{routeOpt.routes_active}</b> active routes AI-optimized ({routeOpt.optimization_rate_pct}%).
            Projected monthly fuel saving <b style={{ color: 'var(--status-success-text)' }}>£{Number(routeOpt.fuel_saved_month_gbp).toLocaleString()}</b>,
            plus <b style={{ color: 'var(--status-success-text)' }}>£{Number(routeOpt.ev_saving_month_gbp).toLocaleString()}</b>/month from EV vans vs diesel running costs.
          </div>
        )}
      </div>

      <div style={{ height: 1, background: c.borderSubtle }} />

      {/* ── What the optimiser actually traded ──────────────────────────────
          The scorecard above is fuel and minutes, which is the part everybody
          expects. This is the part that matters: on most days the money is in
          appointments protected and revisits avoided, not in diesel. Showing the
          attribution is what separates a real optimiser from a percentage. */}
      <OptimiserAttribution routeOpt={routeOpt} />

      <div style={{ height: 1, background: c.borderSubtle }} />
      {/* ── Arrival risk ────────────────────────────────────────────────────
          The day's savings above are the score; this is the game still being
          played. Every round here is about to miss a booked window, and each
          one carries the six things a dispatcher can actually do about it. */}
      <div>
        <SectionLabel right={<FeedBadge label="Route progress" interval="2m" />}>
          Arrival Risk {openRisks.length ? `(${openRisks.length})` : ''}
        </SectionLabel>
        {openRisks.length === 0 ? (
          <AllClear
            title="Every round is inside its windows"
            body={resolvedRisks.length
              ? `No engineer is projected to miss a booked appointment. ${resolvedRisks.length} round${resolvedRisks.length === 1 ? ' was' : 's were'} recovered this session.`
              : 'No engineer is projected to miss a booked appointment on their remaining stops.'}
          />
        ) : (
          <>
            {/* Jobs first, rounds second. A dispatcher can only act on rounds, but
                what they are being judged on is appointments — and one late round
                can carry four of them. `jobs` is the module's half of the Executive
                Dashboard's Jobs at SLA Risk headline, read from the same endpoint. */}
            <div className="auto-grid" style={{ '--cols': '4', '--col-min': '104px', '--grid-gap': '7px', marginBottom: 10 } as React.CSSProperties}>
              {[
                // Four different questions about the same late rounds, so four
                // different definitions — they were all pointing at the jobs-at-risk
                // explainer, which only answered the first one.
                { label: 'Jobs at risk', value: jobRisk?.arrival_delay ?? s?.jobs_at_risk ?? 0, color: c.danger.text, tip: 'Jobs at Risk · Arrival', icon: <Home size={13} /> },
                { label: 'Late rounds', value: s?.engineers_late ?? 0, color: c.warning.text, tip: 'Rounds Running Late', icon: <RouteIcon size={13} /> },
                { label: 'P1/P2 jobs', value: s?.sla_jobs_at_risk ?? 0, color: c.danger.text, tip: 'SLA Jobs at Risk', icon: <AlertTriangle size={13} /> },
                { label: 'Worst breach', value: `${s?.worst_breach_mins ?? 0}m`, color: c.danger.text, tip: 'Worst Breach', icon: <TimerOff size={13} /> },
              ].map(({ label, value, color, tip, icon }) => (
                <MetricTip key={label} label={tip} title={label} block>
                  <div style={{
                    background: color + '12', border: `1px solid ${color}2e`, borderRadius: 8, padding: '9px 11px',
                    height: '100%',
                  }}>
                    {/* Tiles here are a quarter-width, so the icon runs at 13px and
                        the label is allowed to ellipsize rather than wrap. */}
                    <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                      <span style={{ color, flexShrink: 0, display: 'flex' }} aria-hidden="true">{icon}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
                  </div>
                </MetricTip>
              ))}
            </div>
            {etaError && (
              <div style={{
                fontSize: 11, color: c.danger.text, background: c.danger.bg,
                border: `1px solid ${c.danger.border}`, borderRadius: 7, padding: '7px 10px', marginBottom: 9,
              }}>
                {etaError}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {openRisks.slice(0, 12).map((r) => (
                <EtaRiskCard
                  key={r.engineer_code} risk={r}
                  onResolve={(action: string) => onResolveEta(r.engineer_code, action)}
                  pending={pendingEtaCode === r.engineer_code ? pendingEtaAction : null}
                  onOpenVan={() => byEngineer[r.engineer_code] && onSelect(byEngineer[r.engineer_code])}
                />
              ))}
              {openRisks.length > 12 && (
                <div style={{ fontSize: 11, color: c.textMuted, textAlign: 'center', padding: '4px 0' }}>
                  + {openRisks.length - 12} more round(s) running behind
                </div>
              )}
            </div>
          </>
        )}
        {resolvedRisks.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
            {resolvedRisks.slice(0, 6).map((r) => (
              <div key={r.engineer_code}>
                <div style={{ fontSize: 11, fontWeight: 700, color: c.textPrimary, marginBottom: 3 }}>
                  {r.engineer_name}
                </div>
                <ResolutionOutcome resolution={r.resolution} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: c.borderSubtle }} />

      {/* Biggest wins */}
      <div>
        <SectionLabel>Biggest Time Savings Today</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(routeOpt?.top_routes ?? []).map((r: any) => {
            const van = byEngineer[r.engineer_code]
            return (
              <button
                key={r.engineer_code}
                onClick={() => van && onSelect(van)}
                style={{
                  padding: '9px 11px', background: 'var(--clt-grey-50)', borderRadius: 7,
                  border: '1px solid var(--clt-grey-100)', cursor: van ? 'pointer' : 'default',
                  textAlign: 'left', width: '100%',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary }}>{r.engineer_name}</span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--status-success-text)' }}>−{r.mins_saved} min</span>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--clt-grey-500)', flexWrap: 'wrap' }}>
                  <span>{r.stops_total} stops</span>
                  <span>{r.planned_travel_mins} → <b>{r.optimized_travel_mins} min</b> travel</span>
                  <span>−{r.miles_saved} mi</span>
                  {r.saving_gbp > 0 && (
                    <span style={{ color: 'var(--status-success-text)', fontWeight: 700 }}>
                      £{Number(r.saving_gbp).toLocaleString()} saved
                    </span>
                  )}
                  {r.collections > 0 && <span>{r.collections} locker pickup{r.collections > 1 ? 's' : ''}</span>}
                </div>
              </button>
            )
          })}
          {(!routeOpt || routeOpt.top_routes.length === 0) && <EmptyNote>No optimized routes yet</EmptyNote>}
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', lineHeight: 1.6 }}>
        Select any van from the map or Vans tab to see its full stop-by-stop route drawn
        from its live position — identical to the Live Visibility Hub feed.
      </div>
    </div>
  )
}

// ── Optimiser attribution ───────────────────────────────────────────────────
// Where today's saving actually came from. The optimiser prices seven factors in
// pounds — travel, distance, SLA breach, failed first-time fix, waiting on a
// two-man delivery, clean air zone charges and overtime — and on most days the
// largest single term is not the one people expect. Publishing the split is the
// difference between a number an operator trusts and one they override.

const FACTOR_COLOR: Record<string, string> = {
  sla: '#EF4444',
  first_time_fix: '#F97316',
  travel_time: '#3B82F6',
  distance: '#8B5CF6',
  parts_wait: '#F59E0B',
  clean_air_zones: '#0EA5E9',
  overtime: '#EC4899',
}

const PARTS_LABEL: Record<string, string> = {
  ready: 'In van stock',
  collect: 'Locker collection',
  await_delivery: 'Direct-to-site delivery',
  shortfall: 'No source — revisit risk',
}
const PARTS_COLOR: Record<string, string> = {
  ready: '#10B981', collect: '#3B82F6', await_delivery: '#F59E0B', shortfall: '#EF4444',
}

function OptimiserAttribution({ routeOpt }: any) {
  const { c } = useTheme()
  if (!routeOpt) return null

  const factors: any[] = (routeOpt.factors ?? []).filter((f: any) => Math.abs(f.saving_gbp) >= 0.5)
  const peak = Math.max(1, ...factors.map((f: any) => Math.abs(f.saving_gbp)))
  const parts: Record<string, number> = routeOpt.parts_readiness ?? {}
  const partsTotal = Object.values(parts).reduce((a: number, b: number) => a + b, 0)

  return (
    <div>
      <SectionLabel>Why — What the Optimiser Traded</SectionLabel>

      <div style={{
        fontSize: 11, color: c.textSecondary, background: 'var(--clt-grey-50)',
        borderRadius: 7, padding: '8px 11px', lineHeight: 1.6, marginBottom: 10,
      }}>
        Booked sequence <b>£{Number(routeOpt.cost_baseline_gbp).toLocaleString()}</b> →
        optimised <b>£{Number(routeOpt.cost_optimised_gbp).toLocaleString()}</b>, a saving of{' '}
        <b style={{ color: 'var(--status-success-text)' }}>£{Number(routeOpt.cost_saved_gbp).toLocaleString()}</b>{' '}
        across the fleet. Sequenced against live traffic (<b>{routeOpt.traffic_severity}</b>),
        engineer accreditations, parts availability and committed customer windows.
      </div>

      {factors.length === 0 ? (
        <EmptyNote>Every round is already optimally sequenced</EmptyNote>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {factors.map((f: any) => {
            const color = FACTOR_COLOR[f.key] ?? '#64748B'
            const width = Math.max(2, (Math.abs(f.saving_gbp) / peak) * 100)
            return (
              <div key={f.key} title={f.why}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: c.textPrimary, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.label}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 800, color: f.saving_gbp >= 0 ? 'var(--status-success-text)' : c.danger.text, flexShrink: 0 }}>
                    {f.saving_gbp >= 0 ? '' : '+'}£{Math.abs(f.saving_gbp).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
                <div style={{ height: 6, background: 'var(--clt-grey-100)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${width}%`, height: '100%', background: color, borderRadius: 3 }} />
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--clt-grey-500)', marginTop: 3 }}>
                  {Number(f.delta).toLocaleString()} {f.unit} across {f.routes} round{f.routes === 1 ? '' : 's'}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Parts readiness — the factor a distance-only optimiser cannot see.
          Every job whose critical part has no source is a visit that will not
          fix it first time, and a second van sent back tomorrow. */}
      {partsTotal > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: c.textPrimary, marginBottom: 6 }}>
            Parts readiness across {partsTotal.toLocaleString()} scheduled job{partsTotal === 1 ? '' : 's'}
          </div>
          <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 7 }}>
            {['ready', 'collect', 'await_delivery', 'shortfall'].map(k => (parts[k] ? (
              <div key={k} style={{ flex: parts[k], background: PARTS_COLOR[k] }} title={`${PARTS_LABEL[k]}: ${parts[k]}`} />
            ) : null))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
            {['ready', 'collect', 'await_delivery', 'shortfall'].map(k => (parts[k] ? (
              <span key={k} style={{ fontSize: 10.5, color: 'var(--clt-grey-500)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 7, height: 7, borderRadius: 2, background: PARTS_COLOR[k], flexShrink: 0 }} />
                {PARTS_LABEL[k]} <b style={{ color: c.textPrimary }}>{parts[k]}</b>
              </span>
            ) : null))}
          </div>
        </div>
      )}

      {/* Accreditation is a hard constraint, not a cost. A job an engineer
          cannot legally do is not priced and kept — it is pulled out here for
          somebody to reallocate. */}
      {routeOpt.jobs_needing_reallocation_total > 0 && (
        <div style={{
          marginTop: 12, background: c.warning.bg, border: `1px solid ${c.warning.border}`,
          borderRadius: 7, padding: '9px 11px',
        }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: c.warning.text, display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
            <ShieldAlert size={13} />
            {routeOpt.jobs_needing_reallocation_total} job{routeOpt.jobs_needing_reallocation_total === 1 ? '' : 's'} booked to an engineer without the accreditation
          </div>
          <div style={{ fontSize: 10.5, color: c.textSecondary, lineHeight: 1.6, marginBottom: 6 }}>
            Gas work without the ticket is an offence, not an inefficiency — these cannot be
            sequenced and need reallocating.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(routeOpt.jobs_needing_reallocation ?? []).slice(0, 5).map((j: any) => (
              <div key={`${j.engineer_code}-${j.job_code}`} style={{ fontSize: 10.5, color: c.textSecondary }}>
                <b style={{ color: c.textPrimary }}>{j.job_code}</b> · {j.job_type?.replace(/_/g, ' ')} ·{' '}
                {j.engineer_name} lacks {(j.missing_skill_labels ?? []).join(', ')}
              </div>
            ))}
            {routeOpt.jobs_needing_reallocation_total > 5 && (
              <div style={{ fontSize: 10.5, color: 'var(--clt-grey-500)' }}>
                + {routeOpt.jobs_needing_reallocation_total - 5} more
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Live re-optimisation ────────────────────────────────────────────────────
// Preview first, commit second. A dispatcher is being asked to move a named
// person's afternoon around, so they get to see what it buys — and what it
// costs the customers whose windows move — before anything changes.

function LiveReoptimise({ engineerCode }: { engineerCode: string }) {
  const { c } = useTheme()
  const qc = useQueryClient()
  const [preview, setPreview] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  const run = useMutation({
    mutationFn: ({ apply }: { apply: boolean }) => optimizeEngineerRoute(engineerCode, apply),
    onSuccess: (d: any, vars) => {
      if (d?.error) { setErr(d.error); setPreview(null); return }
      setErr(null)
      setPreview(d)
      if (vars.apply) {
        for (const k of [['engineer-route'], ['route-optimization'], ['fleet'], ['eta-risk'], ['map-data']]) {
          qc.invalidateQueries({ queryKey: k })
        }
      }
    },
    onError: (e: any) => setErr(
      e?.response?.status === 403
        ? 'Your role can view the optimiser result but not commit it to a round.'
        : 'Could not reach the optimiser — try again.'),
  })

  const busy = run.isPending
  const nothingToGain = preview && !preview.applied
  const committed = preview?.applied_to_round

  return (
    <div style={{
      background: 'var(--clt-grey-50)', border: '1px solid var(--clt-grey-200)',
      borderRadius: 8, padding: '9px 11px', marginBottom: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: c.textPrimary, display: 'flex', alignItems: 'center', gap: 5 }}>
          <RouteIcon size={13} /> Re-optimise from current position
        </span>
        <button
          onClick={() => run.mutate({ apply: false })}
          disabled={busy}
          style={{
            fontSize: 10.5, fontWeight: 700, padding: '4px 9px', borderRadius: 6,
            border: `1px solid ${c.borderSubtle}`, background: 'var(--clt-white)',
            color: c.textSecondary, cursor: busy ? 'wait' : 'pointer', flexShrink: 0,
          }}
        >
          {busy ? 'Running…' : preview ? 'Re-run' : 'Preview'}
        </button>
      </div>

      {err && (
        <div style={{ fontSize: 10.5, color: c.danger.text, marginTop: 6 }}>{err}</div>
      )}

      {preview && !err && (
        <div style={{ marginTop: 7, fontSize: 10.5, color: c.textSecondary, lineHeight: 1.7 }}>
          <div>
            From <b>{preview.start_at}</b> in <b>{preview.traffic_severity}</b> traffic:{' '}
            {preview.baseline.travel_miles} mi / {preview.baseline.travel_mins} min →{' '}
            <b>{preview.optimised.travel_miles} mi / {preview.optimised.travel_mins} min</b>
          </div>
          {nothingToGain ? (
            <div style={{ marginTop: 4, color: 'var(--clt-grey-500)' }}>
              The remaining stops are already in the best order available — nothing to recover.
            </div>
          ) : (
            <>
              <div style={{ color: 'var(--status-success-text)', fontWeight: 700 }}>
                −{preview.mins_saved} min · −{preview.miles_saved} mi · £{preview.saving_gbp} ·{' '}
                {preview.sla_jobs_protected > 0 ? `${preview.sla_jobs_protected} appointment(s) protected` : 'no window changes'}
              </div>
              {(preview.factors ?? []).filter((f: any) => Math.abs(f.saving_gbp) >= 0.5).map((f: any) => (
                <div key={f.key} style={{ color: 'var(--clt-grey-500)' }}>
                  · {f.label}: {f.baseline} → {f.optimised} {f.unit} (£{f.saving_gbp})
                </div>
              ))}
              <div style={{ color: 'var(--clt-grey-500)' }}>
                Projected finish <b>{preview.constraints.projected_finish}</b>
                {preview.constraints.overtime_mins > 0 && (
                  <span style={{ color: c.warning.text }}> · {preview.constraints.overtime_mins} min overtime</span>
                )}
                {preview.constraints.drivers_hours_breach && (
                  <span style={{ color: c.danger.text, fontWeight: 700 }}> · breaches drivers' hours</span>
                )}
              </div>
              {committed ? (
                <div style={{ marginTop: 5, color: 'var(--status-success-text)', fontWeight: 700 }}>
                  ✓ Committed to the live round — customers with a confirmed window need telling.
                </div>
              ) : (
                <button
                  onClick={() => run.mutate({ apply: true })}
                  disabled={busy}
                  style={{
                    marginTop: 6, fontSize: 10.5, fontWeight: 700, padding: '5px 10px', borderRadius: 6,
                    border: 'none', background: 'var(--status-success-text)', color: '#fff',
                    cursor: busy ? 'wait' : 'pointer',
                  }}
                >
                  Apply to this round
                </button>
              )}
            </>
          )}
          {preview.jobs_needing_reallocation?.length > 0 && (
            <div style={{ marginTop: 5, color: c.warning.text }}>
              {preview.jobs_needing_reallocation.length} stop(s) cannot be sequenced —{' '}
              {preview.engineer_name} lacks the accreditation. Reallocate.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// One round running behind: how far, why, which appointments it puts past their
// committed window, and the six courses of action a dispatcher has.

function EtaRiskCard({ risk, onResolve, pending, onOpenVan }: {
  risk: any; onResolve: (action: string) => void; pending: string | null; onOpenVan: () => void
}) {
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  const sev = SEVERITY_COLOR[risk.severity] ?? '#F59E0B'
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
          <TimerOff size={13} color={sev} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, fontWeight: 700, color: c.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {risk.engineer_name}
          </span>
          <span style={{ fontSize: 13, fontWeight: 900, color: sev }}>+{fmtDelay(risk.delay_mins)}</span>
          <SeverityPill severity={risk.severity} />
        </div>
        <div style={{ fontSize: 11, color: c.textMuted, marginBottom: 5 }}>
          {risk.registration ?? risk.engineer_code} · {risk.region} · {risk.cause_label}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {risk.stops_at_risk.slice(0, 3).map((st: any) => (
            <div key={st.job_code} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <span style={{
                fontSize: 11, fontWeight: 800, padding: '1px 5px', borderRadius: 3,
                background: st.priority === 'P1' ? '#EF4444' : st.priority === 'P2' ? '#F97316' : c.chipBg,
                color: st.priority === 'standard' ? c.chipText : '#fff',
              }}>
                {st.priority === 'standard' ? 'STD' : st.priority}
              </span>
              <span style={{ color: c.textSecondary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {st.job_type?.replace(/_/g, ' ')} · {st.postcode}
              </span>
              <span style={{ color: c.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                {st.planned_arrival} → <b style={{ color: sev }}>{st.projected_arrival}</b>
              </span>
              <span style={{ fontSize: 11, fontWeight: 800, color: sev }}>+{st.breach_mins}m</span>
            </div>
          ))}
          {risk.stops_at_risk.length > 3 && (
            <div style={{ fontSize: 11, color: c.textMuted }}>
              + {risk.stops_at_risk.length - 3} more appointment(s) past their window
            </div>
          )}
        </div>
      </button>
      {open && (
        <div style={{ padding: '0 12px 12px', borderTop: `1px solid ${c.borderSubtle}` }}>
          <OptionsHeader>
            <CardLink onClick={onOpenVan} title="Open this engineer's round on the map">
              Open route
            </CardLink>
          </OptionsHeader>
          <OptionList options={risk.options ?? []} onApply={onResolve} pending={pending} />
        </div>
      )}
    </div>
  )
}

// ─── Carriers panel ──────────────────────────────────────────────────────────
// Third-party legs out of the hubs into the forward network. Everything here is
// somebody else's vehicle, which is exactly why it needs its own queue: the
// levers are different (escalate, re-book with the standby carrier, split,
// divert, cover from hub, move the customer) and none of them is "drive faster".

function CarriersPanel({
  data, filter, setFilter, onResolve, pendingRef, pendingAction, error, onSelectEngineer, onOpenDetails,
}: any) {
  const { c } = useTheme()
  const [expanded, setExpanded] = useState<string | null>(null)

  if (!data) {
    return <div style={{ textAlign: 'center', padding: '24px 0', color: c.textMuted, fontSize: 12 }}>Loading…</div>
  }

  const all: any[] = data.items ?? []
  const s = data.summary ?? {}
  const shown = all.filter((m) => {
    if (filter === 'delayed') return (m.delay_mins ?? 0) > 0 && m.status !== 'delivered'
    if (filter === 'all') return true
    return m.dest_type === filter
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* A leg ATLAS escalated or diverted looks the same as one that was never
          late once it recovers. The audit trail is what remembers. */}
      <ActionedToday module="/transport" section="Carrier Delays" label="late leg" />
      {/* Scorecard */}
      <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px' } as React.CSSProperties}>
        {[
          { label: 'In flight', val: s.in_flight ?? 0, color: c.info.text, icon: <Package size={13} />, tip: 'Carriers In Flight' },
          { label: 'Delayed', val: s.delayed ?? 0, color: (s.delayed ?? 0) > 0 ? '#EF4444' : '#10B981', icon: <Clock size={13} />, tip: 'Carrier Delays' },
          { label: 'On time', val: `${(s.on_time_pct ?? 100).toFixed(0)}%`, color: (s.on_time_pct ?? 100) >= 90 ? '#10B981' : '#F59E0B', icon: <PackageCheck size={13} />, tip: 'Carrier On-Time' },
          { label: 'Bulky in flight', val: s.bulky_in_flight ?? 0, color: c.warning.text, icon: <Home size={13} />, tip: 'Bulky In Flight' },
        ].map(({ label, val, color, icon, tip }) => (
          <MetricTip key={label} label={tip} title={label} block>
            <div style={{
              background: color + '12', border: `1px solid ${color}2e`, borderRadius: 8, padding: '10px 12px',
              height: '100%',
            }}>
              <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ color }} aria-hidden="true">{icon}</span>{label}
              </div>
              <div style={{ fontSize: 21, fontWeight: 900, color, lineHeight: 1 }}>{val}</div>
            </div>
          </MetricTip>
        ))}
      </div>

      <div style={{ fontSize: 11, color: c.textSecondary, lineHeight: 1.55 }}>
        Hub → forward network legs run by third parties. Small parts go to a{' '}
        <b>ByBox locker</b> for pre-8AM collection or into the engineer's{' '}
        <b>boot</b> overnight; bulky units go <b>two-man to the job address</b>,
        because they fit in neither.
      </div>

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        {([
          { key: 'delayed', label: `Delayed (${s.delayed ?? 0})` },
          { key: 'all', label: `All (${all.length})` },
          { key: 'locker', label: `Locker (${s.by_dest?.locker ?? 0})` },
          { key: 'in_boot', label: `In-boot (${s.by_dest?.in_boot ?? 0})` },
          { key: 'job_site', label: `Job site (${s.by_dest?.job_site ?? 0})` },
        ] as { key: CarrierFilter; label: string }[]).map(({ key, label }) => (
          <button key={key} onClick={() => setFilter(key)} style={{
            padding: '3px 9px', fontSize: 11, fontWeight: 600, borderRadius: 20,
            border: `1px solid ${filter === key ? 'var(--exl-orange)' : c.border}`,
            background: filter === key ? 'var(--exl-orange)' : 'transparent',
            color: filter === key ? '#fff' : c.textSecondary, cursor: 'pointer',
          }}>
            {label}
          </button>
        ))}
        <FeedBadge label="Carrier tracking" interval="5m" />
      </div>

      {error && (
        <div style={{
          fontSize: 11, color: c.danger.text, background: c.danger.bg,
          border: `1px solid ${c.danger.border}`, borderRadius: 7, padding: '7px 10px',
        }}>
          {error}
        </div>
      )}

      {filter === 'delayed' && shown.length === 0 ? (
        <AllClear
          title="Every carrier leg is running to promise"
          body="No third-party consignment into a locker, a van boot or a job address is behind its promised time."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {shown.slice(0, 30).map((m: any) => (
            <CarrierCard
              key={m.movement_ref} mv={m}
              expanded={expanded === m.movement_ref}
              onToggle={() => setExpanded(expanded === m.movement_ref ? null : m.movement_ref)}
              onResolve={(action: string) => onResolve(m.movement_ref, action)}
              pending={pendingRef === m.movement_ref ? pendingAction : null}
              onSelectEngineer={onSelectEngineer}
              onOpenDetails={() => onOpenDetails(m.movement_ref)}
            />
          ))}
          {shown.length === 0 && (
            <EmptyNote>No movements match this filter</EmptyNote>
          )}
          {shown.length > 30 && (
            <div style={{ fontSize: 11, color: c.textMuted, textAlign: 'center', padding: '4px 0' }}>
              + {shown.length - 30} more — narrow the filter
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CarrierCard({ mv, expanded, onToggle, onResolve, pending, onSelectEngineer, onOpenDetails }: any) {
  const { c } = useTheme()
  const dest = DEST_META[mv.dest_type] ?? DEST_META.locker
  const DestIcon = dest.icon
  const late = (mv.delay_mins ?? 0) > 0 && mv.status !== 'delivered'
  // A consignment somebody has already acted on shows the outcome, not a fresh
  // set of options to act on again.
  const showOptions = late && !mv.resolution
  const tone = movementTone(c, mv.status, late).solid

  return (
    <div style={{
      border: `1px solid ${expanded ? tone + '66' : c.border}`, borderRadius: 9,
      background: c.surface, overflow: 'hidden',
    }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', textAlign: 'left', background: expanded ? tone + '0d' : 'transparent',
          border: 'none', cursor: 'pointer', padding: '10px 12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
          <DestIcon size={13} color={toneOf(c, dest.tone).text} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary, fontFamily: 'monospace' }}>
            {mv.movement_ref}
          </span>
          {mv.is_bulky && (
            <span
              title="Two-man bulky consignment — it cannot go to a locker or in a boot, and it cannot be split"
              style={{
                fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
                padding: '1px 6px', borderRadius: 4, background: '#F9731622', color: 'var(--accent-text)',
              }}
            >
              Bulky
            </span>
          )}
          <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
            <span style={{
              fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
              padding: '2px 7px', borderRadius: 4, background: tone + '1e', color: tone,
              border: `1px solid ${tone}44`,
            }}>
              {late ? `+${fmtDelay(mv.delay_mins)} late` : mv.status.replace(/_/g, ' ')}
            </span>
          </span>
        </div>

        <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 4, lineHeight: 1.45 }}>
          <b style={{ color: c.textPrimary }}>{mv.origin_name}</b> → {mv.dest_name}
          {mv.dest_postcode ? ` · ${mv.dest_postcode}` : ''}
        </div>

        <div style={{ display: 'flex', gap: 10, fontSize: 11, color: c.textMuted, flexWrap: 'wrap' }}>
          <span>{mv.carrier}</span>
          <span>{mv.service_label}</span>
          <span>{mv.pieces} pc · {mv.weight_kg} kg</span>
          <span style={{ marginLeft: 'auto', color: late ? '#EF4444' : c.textSecondary, fontWeight: 700 }}>
            ETA {fmtEta(mv.eta)}
          </span>
        </div>

        {mv.linked_engineer_name && (
          <div style={{ fontSize: 11, color: c.textMuted, marginTop: 4 }}>
            For {mv.linked_engineer_name}{mv.linked_job_code ? ` · ${mv.linked_job_code}` : ''}
          </div>
        )}
      </button>

      {expanded && (
        <div style={{ padding: '0 12px 12px', borderTop: `1px solid ${c.borderSubtle}` }}>
          {/* Consignment */}
          <div style={{ marginTop: 9 }}>
            <CardSubLabel>Consignment</CardSubLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {mv.lines.map((l: any) => (
                <div key={l.sku_code} style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                  <span style={{ fontFamily: 'monospace', color: c.textSecondary }}>{l.sku_code}</span>
                  <span style={{ flex: 1, minWidth: 0, color: c.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.description}
                  </span>
                  <span style={{ fontWeight: 700, color: c.textPrimary }}>×{l.quantity}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Milestones */}
          <div style={{ marginTop: 11 }}>
            <CardSubLabel>Tracking</CardSubLabel>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {mv.milestones.map((ms: any, i: number) => {
                const isDelay = ms.key === 'delayed'
                return (
                  <div key={i} style={{ display: 'flex', gap: 8, position: 'relative' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12, flexShrink: 0 }}>
                      <div style={{
                        width: 7, height: 7, borderRadius: '50%', marginTop: 4,
                        background: movementTone(c, ms.key, isDelay).solid,
                      }} />
                      {i < mv.milestones.length - 1 && (
                        <div style={{ width: 1.5, flex: 1, background: c.border, minHeight: 12 }} />
                      )}
                    </div>
                    <div style={{ flex: 1, paddingBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: isDelay ? 700 : 600, color: isDelay ? c.danger.text : c.textPrimary }}>
                        {ms.event}
                      </div>
                      <div style={{ fontSize: 11, color: c.textMuted }}>
                        {ms.location} · {fmtEta(ms.at)}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Header row first, then whatever this consignment's state calls for
              — the same order as every other alert card. The links live here,
              right-aligned, rather than at the bottom-left after the option
              list, which is what put the same gesture in two different corners
              depending on which queue you happened to be working. The row is
              rendered in every state, so the CTAs do not move about as the
              consignment progresses. */}
          <OptionsHeader label={showOptions ? 'Options' : 'Consignment'}>
            <CardLink onClick={onOpenDetails} title="Open the full consignment record">
              Full record
            </CardLink>
            {mv.linked_engineer_code && (
              <CardLink
                onClick={() => onSelectEngineer(mv.linked_engineer_code)}
                title={`Open ${mv.linked_engineer_name}'s van`}
              >
                Open van
              </CardLink>
            )}
          </OptionsHeader>

          {mv.resolution ? (
            <ResolutionOutcome resolution={mv.resolution} />
          ) : showOptions ? (
            <OptionList options={mv.options ?? []} onApply={onResolve} pending={pending} />
          ) : (
            <div style={{ fontSize: 11, color: c.textMuted }}>
              Running to promise — nothing to decide.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Vehicles panel ──────────────────────────────────────────────────────────

function VehiclesPanel({ vehicles, allCount, search, setSearch, filter, setFilter, onSelect, searchRef }: any) {
  const { c } = useTheme()
  return (
    <div>
      <div style={{ position: 'relative', marginBottom: 10 }}>
        <Search size={13} aria-hidden="true" style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: c.textMuted, pointerEvents: 'none' }} />
        <input
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search reg, driver, model…"
          aria-label="Search vans by registration, driver or model"
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

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
        {FILTER_CHIPS.map(({ key, label }) => (
          <button key={key} onClick={() => setFilter(key)} style={{
            padding: '3px 9px', fontSize: 11, fontWeight: 600, borderRadius: 20,
            border: `1px solid ${filter === key ? 'var(--exl-orange)' : c.border}`,
            background: filter === key ? 'var(--exl-orange)' : 'transparent',
            color: filter === key ? '#fff' : c.textSecondary,
            cursor: 'pointer', transition: 'all 120ms',
          }}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', marginBottom: 8 }}>
        Showing {Math.min(vehicles.length, 100)} of {vehicles.length}
        {vehicles.length < allCount ? ` filtered from ${allCount}` : ''}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {vehicles.slice(0, 100).map((v: any) => {
          const hasIssue = v.vor || v.defects.some((d: any) => d.status === 'open')
          return (
            <button
              key={v.registration}
              onClick={() => onSelect(v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px',
                borderRadius: 6, cursor: 'pointer', border: 'none', background: 'transparent',
                width: '100%', textAlign: 'left', transition: 'background 100ms',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = c.surfaceSubtle)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: vanTone(c, v.job_status).solid }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {v.registration}
                  {v.fuel_type === 'ev' && <Zap size={11} color={c.success.text} />}
                  {v.vor && <span style={{ fontSize: 11, fontWeight: 800, background: '#EF4444', color: '#fff', borderRadius: 3, padding: '1px 4px' }}>VOR</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {v.make_model} · {v.engineer_name}
                </div>
              </div>
              {hasIssue && !v.vor && <AlertTriangle size={13} color={c.warning.text} />}
              <ChevronRight size={13} color="var(--clt-grey-300)" />
            </button>
          )
        })}
        {vehicles.length === 0 && (
          <EmptyNote>No vehicles match current filters</EmptyNote>
        )}
      </div>
    </div>
  )
}

// ─── Overview panel ──────────────────────────────────────────────────────────

/**
 * One figure in the overview grid. Clickable when there is somewhere to go, and
 * self-explaining when it has a definition.
 *
 * When both apply, MetricTip IS the button rather than wrapping one — otherwise
 * every tile would carry two tab stops, twenty-four across this panel.
 */
function StatTile({ label, value, tone, note, icon, onClick, tip }: {
  label: string; value: React.ReactNode; tone?: string; note?: string
  icon?: React.ReactNode; onClick?: () => void
  /** KPI_DEFINITIONS key for the hover/focus explainer. */
  tip?: string
}) {
  const { c } = useTheme()
  const Box: any = onClick && !tip ? 'button' : 'div'
  const body = (
    <Box
      onClick={tip ? undefined : onClick}
      title={onClick && !tip ? `Open ${label}` : undefined}
      style={{
        padding: '9px 10px', background: 'var(--clt-grey-50)', borderRadius: 7,
        border: `1px solid ${tone ? tone + '44' : 'var(--clt-grey-100)'}`,
        textAlign: 'left', width: '100%', cursor: onClick ? 'pointer' : 'default',
        display: 'flex', flexDirection: 'column', gap: 2,
      }}
    >
      {/* The icon takes the tile's status colour when it has one, so a tile that
          has gone red reads as red at a glance — but it is decoration only, and
          the label and value both say the same thing without it. */}
      <span style={{ fontSize: 11, color: 'var(--clt-grey-500)', display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        {icon && (
          <span style={{ color: tone ?? 'var(--clt-grey-400)', flexShrink: 0, display: 'flex' }} aria-hidden="true">
            {icon}
          </span>
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      </span>
      <span style={{ fontSize: 17, fontWeight: 800, color: tone ?? c.textPrimary, fontVariantNumeric: 'tabular-nums' }}>
        {value ?? '—'}
      </span>
      {note && <span style={{ fontSize: 11, color: 'var(--clt-grey-400)' }}>{note}</span>}
    </Box>
  )

  if (!tip) return body
  return (
    <MetricTip
      label={tip}
      title={label}
      block
      onActivate={onClick}
      activateLabel={onClick
        ? `${label}: ${value ?? 'no data'}.${note ? ` ${note}.` : ''} Open ${label}`
        : undefined}
    >
      {body}
    </MetricTip>
  )
}

/**
 * The state of the transport operation on one screen.
 *
 * Every tile is a summary of a queue that has its own tab, and clicking it opens
 * that tab pre-filtered — the overview is a way in, not a fifth copy of the data.
 * The driver block at the bottom is what remains of the old Drivers tab: the
 * ranking, which was the only thing it offered that a van's detail view does not.
 */
function OverviewPanel({ summary, etaSummary, carrierSummary, worstDrivers, onSelect, onGoTo, onGoToFleet, onGoToCarriers }: any) {
  const { c } = useTheme()

  // A spinner says "wait"; a skeleton says "three bands of tiles and a ranked
  // list are coming", which is the difference between waiting and knowing. The
  // shape shown here is the shape that arrives.
  if (!summary) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <SectionLabel>Live Operation</SectionLabel>
          <SkeletonTiles count={4} />
        </div>
        <div>
          <SectionLabel>Compliance</SectionLabel>
          <SkeletonTiles count={4} />
        </div>
        <div>
          <SectionLabel>Drivers Needing Coaching</SectionLabel>
          <SkeletonRows count={3} height={44} />
        </div>
      </div>
    )
  }

  const s = summary ?? {}
  const late = etaSummary?.engineers_late ?? 0
  const delayed = carrierSummary?.delayed ?? 0
  const grid = { '--cols': '2', '--col-min': '150px', '--grid-gap': '8px', marginBottom: 16 } as React.CSSProperties

  // Only the drivers actually below the coaching bar. A "worst 15" list always
  // has fifteen entries even when the whole fleet is driving well, which reads
  // as a standing problem that is not there.
  const needCoaching = (worstDrivers ?? []).filter((v: any) => v.driver_score < 70).slice(0, 5)

  return (
    <div>
      <SectionLabel>Live Operation</SectionLabel>
      <div className="auto-grid" style={grid}>
        <StatTile
          label="Active vans" value={s.active_vehicles} icon={<Truck size={13} />} tip="Active Vans"
          note={`${s.en_route ?? 0} en route · ${s.fleet_size ?? 0} in fleet`}
          onClick={() => onGoToFleet('all')}
        />
        <StatTile
          label="Off road (VOR)" value={s.vor_count} icon={<XCircle size={13} />} tip="VOR"
          tone={s.vor_count > 0 ? c.danger.text : undefined}
          note={s.vor_count > 0 ? 'Capacity lost today' : 'Full fleet available'}
          onClick={() => onGoToFleet('vor')}
        />
        <StatTile
          label="Engineers late" value={late} icon={<TimerOff size={13} />} tip="Engineers Late"
          tone={late > 0 ? c.warning.text : undefined}
          note={late > 0 ? `${etaSummary?.jobs_at_risk ?? 0} job${etaSummary?.jobs_at_risk === 1 ? '' : 's'} at risk` : 'All rounds on time'}
          onClick={() => onGoTo('routes')}
        />
        <StatTile
          label="Carrier delays" value={delayed} icon={<Package size={13} />} tip="Carrier Delays"
          tone={delayed > 0 ? c.danger.text : undefined}
          note={delayed > 0 ? `${carrierSummary?.bulky_in_flight ?? 0} bulky in flight` : 'No third-party legs late'}
          onClick={() => onGoToCarriers(delayed > 0 ? 'delayed' : 'all')}
        />
      </div>

      <SectionLabel>Compliance</SectionLabel>
      <div className="auto-grid" style={grid}>
        <StatTile
          label="Walkaround" value={s.walkaround_compliance_pct != null ? `${s.walkaround_compliance_pct}%` : '—'}
          icon={<ClipboardCheck size={13} />} tip="Walkaround Compliance"
          tone={s.walkaround_compliance_pct != null && s.walkaround_compliance_pct < 95 ? c.warning.text : c.success.text}
          note={`${s.walkaround_missing ?? 0} missing today`}
          onClick={() => onGoTo('compliance')}
        />
        <StatTile
          label="Open defects" value={s.open_defects} icon={<Wrench size={13} />} tip="Open Defects"
          tone={s.open_defects > 0 ? c.warning.text : undefined}
          onClick={() => onGoToFleet('defects')}
        />
        <StatTile
          label="MOT due ≤30d" value={s.mot_due_30d} icon={<Clock size={13} />} tip="MOT Due 30d"
          tone={s.mot_due_30d > 0 ? c.warning.text : undefined}
          onClick={() => onGoToFleet('mot_due')}
        />
        <StatTile
          label="CAZ non-compliant" value={s.caz_non_compliant} icon={<ShieldAlert size={13} />} tip="CAZ Non-Compliant"
          tone={s.caz_non_compliant > 0 ? c.warning.text : undefined}
          note={s.caz_non_compliant > 0 ? 'Charged on zone entry' : 'Whole fleet compliant'}
          onClick={() => onGoToFleet('caz_risk')}
        />
      </div>

      <SectionLabel>Fleet Profile</SectionLabel>
      <div className="auto-grid" style={grid}>
        <StatTile
          label="Electric vans" value={s.ev_fleet_pct != null ? `${s.ev_fleet_pct}%` : '—'}
          icon={<Zap size={13} />} tip="Electric Vans"
          note={`${s.ev_count ?? 0} of ${s.fleet_size ?? 0}`}
          onClick={() => onGoToFleet('ev')}
        />
        <StatTile
          label="Avg driver score" value={s.avg_driver_score} icon={<Gauge size={13} />} tip="Avg Driver Score"
          tone={s.avg_driver_score != null ? scoreColor(c, s.avg_driver_score) : undefined}
        />
        <StatTile
          label="Fuel cost / month" icon={<PiggyBank size={13} />} tip="Fleet Fuel Cost"
          value={s.fleet_fuel_cost_month_gbp != null ? `£${Math.round(s.fleet_fuel_cost_month_gbp).toLocaleString()}` : '—'}
        />
        <StatTile
          label="Fleet CO₂ / month" icon={<Leaf size={13} />} tip="Fleet CO₂"
          value={s.fleet_co2_kg_month != null ? `${Math.round(s.fleet_co2_kg_month / 1000).toLocaleString()}t` : '—'}
        />
      </div>

      <MetricTip label="Driver Score">
        <SectionLabel>Drivers Needing Coaching</SectionLabel>
      </MetricTip>
      {needCoaching.length === 0 ? (
        <EmptyNote>No driver is scoring below 70 — nothing to coach today.</EmptyNote>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {needCoaching.map((v: any) => {
            const sc = scoreColor(c, v.driver_score)
            return (
              <button key={v.registration} onClick={() => onSelect(v)} style={{
                padding: '9px 11px', background: 'var(--clt-grey-50)', borderRadius: 7,
                border: '1px solid var(--clt-grey-100)', cursor: 'pointer', textAlign: 'left', width: '100%',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                  <div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: c.textPrimary }}>{v.engineer_name}</span>
                    <span style={{ fontSize: 11, color: 'var(--clt-grey-400)', marginLeft: 6 }}>{v.registration}</span>
                  </div>
                  <span style={{ fontSize: 15, fontWeight: 800, color: sc }}>{v.driver_score}</span>
                </div>
                <div style={{ height: 4, background: 'var(--clt-grey-200)', borderRadius: 2, overflow: 'hidden', marginBottom: 5 }}>
                  <div style={{ height: '100%', width: `${v.driver_score}%`, background: sc, borderRadius: 2 }} />
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--clt-grey-500)' }}>
                  <span>Harsh braking: <b>{v.harsh_braking_7d}</b></span>
                  <span>Speeding: <b>{v.speeding_events_7d}</b></span>
                  <span>Idling: <b>{v.idling_pct}%</b></span>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// The arrival-risk read-out inside a van's detail view: what is at stake and by
// how much.
//
// It deliberately does NOT carry the options. Selecting a van puts the action
// card on the map alongside it, and repeating the same six buttons three inches
// to the right just asks the operator which copy is the real one. The panel
// answers "how bad is this"; the map card answers "what do I do".

function ArrivalRiskBlock({ risk }: { risk: any }) {
  const { c } = useTheme()
  const tone = SEVERITY_COLOR[risk.severity] ?? '#F59E0B'
  return (
    <div style={{ marginBottom: 16 }}>
      <SectionLabel>Arrival Risk</SectionLabel>
      <div style={{
        border: `1px solid ${tone}55`, borderRadius: 9, overflow: 'hidden', background: tone + '0a',
      }}>
        <div style={{ padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
            <TimerOff size={14} color={tone} />
            <span style={{ fontSize: 13, fontWeight: 800, color: tone }}>
              +{fmtDelay(risk.delay_mins)} behind
            </span>
            <SeverityPill severity={risk.severity} />
          </div>
          <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 8, lineHeight: 1.45 }}>
            {risk.cause_label}. <b>{risk.jobs_at_risk}</b> appointment{risk.jobs_at_risk === 1 ? '' : 's'} project
            {' '}past their window, worst by <b>{risk.worst_breach_mins} min</b>
            {risk.sla_jobs_at_risk > 0 && <> · <b>{risk.sla_jobs_at_risk}</b> carry an SLA</>}.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
            {risk.stops_at_risk.map((st: any) => (
              <div key={st.job_code} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <span style={{
                  fontSize: 11, fontWeight: 800, padding: '1px 5px', borderRadius: 3,
                  background: st.priority === 'P1' ? '#EF4444' : st.priority === 'P2' ? '#F97316' : c.chipBg,
                  color: st.priority === 'standard' ? c.chipText : '#fff',
                }}>
                  {st.priority === 'standard' ? 'STD' : st.priority}
                </span>
                <span style={{ color: c.textSecondary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {st.job_code} · {st.postcode}
                </span>
                <span style={{ color: c.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                  {st.planned_arrival} → <b style={{ color: tone }}>{st.projected_arrival}</b>
                </span>
                <span style={{ fontSize: 11, fontWeight: 800, color: tone }}>+{st.breach_mins}m</span>
              </div>
            ))}
          </div>

          <div style={{
            fontSize: 11, color: c.textMuted, lineHeight: 1.5,
            paddingTop: 8, borderTop: `1px solid ${c.borderSubtle}`,
          }}>
            {(risk.options ?? []).filter((o: any) => o.available).length} option(s) available —
            {' '}on the map card for this van.
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Carrier detail ──────────────────────────────────────────────────────────
// The full record of one third-party leg: what is on it, where it has been, and
// what was decided about it.
//
// Read-only by design. The map card alongside it already carries the options for
// this consignment, and a second copy here would only raise the question of
// which one is the real button. This page answers "what is this?"; the card
// answers "what do I do about it?".

function CarrierDetail({ mv, onBack, onSelectEngineer }: any) {
  const { c } = useTheme()
  const dest = DEST_META[mv.dest_type] ?? DEST_META.locker
  const DestIcon = dest.icon
  const late = (mv.delay_mins ?? 0) > 0 && mv.status !== 'delivered'
  const tone = movementTone(c, mv.status, late).solid

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <DetailHeader onBack={onBack}>
        <DetailBadge tone={tone}>
          {late ? `+${fmtDelay(mv.delay_mins)} late` : mv.status.replace(/_/g, ' ')}
        </DetailBadge>
      </DetailHeader>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
            <DestIcon size={15} color={toneOf(c, dest.tone).text} />
            <span style={{ fontSize: 16, fontWeight: 800, color: c.textPrimary, fontFamily: 'monospace' }}>
              {mv.movement_ref}
            </span>
            {mv.is_bulky && (
              <span style={{
                fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
                padding: '1px 6px', borderRadius: 4, background: '#F9731622', color: 'var(--accent-text)',
              }}>
                Bulky
              </span>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: c.textSecondary }}>
            {mv.carrier} · {mv.service_label}
          </div>
        </div>

        <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px', marginBottom: 16 } as React.CSSProperties}>
          {[
            { label: 'From', val: mv.origin_name },
            { label: 'To', val: `${mv.dest_name}${mv.dest_postcode ? ` · ${mv.dest_postcode}` : ''}` },
            { label: 'Promised', val: fmtEta(mv.promised_at) },
            { label: 'ETA', val: fmtEta(mv.eta), alert: late },
            { label: 'Pieces / weight', val: `${mv.pieces} pc · ${mv.weight_kg} kg` },
            { label: 'Freight cost', val: `£${mv.cost_gbp.toFixed(2)}` },
          ].map(({ label, val, alert }) => (
            <div key={label} style={{
              background: alert ? c.danger.bg : c.surfaceSubtle,
              border: `1px solid ${alert ? c.danger.border : c.borderSubtle}`,
              borderRadius: 7, padding: '8px 10px',
            }}>
              <div style={{ fontSize: 11, color: c.textMuted, marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: alert ? c.danger.text : c.textPrimary, lineHeight: 1.35 }}>
                {val}
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginBottom: 16 }}>
          <SectionLabel>Consignment</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {mv.lines.map((l: any) => (
              <div key={l.sku_code} style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                <span style={{ fontFamily: 'monospace', color: c.textSecondary }}>{l.sku_code}</span>
                <span style={{ flex: 1, minWidth: 0, color: c.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {l.description}
                </span>
                <span style={{ fontWeight: 700, color: c.textPrimary }}>×{l.quantity}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <SectionLabel>Tracking</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {mv.milestones.map((ms: any, i: number) => {
              const isDelay = ms.key === 'delayed'
              return (
                <div key={i} style={{ display: 'flex', gap: 9 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12, flexShrink: 0 }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%', marginTop: 4,
                      background: movementTone(c, ms.key, isDelay).solid,
                    }} />
                    {i < mv.milestones.length - 1 && (
                      <div style={{ width: 1.5, flex: 1, background: c.border, minHeight: 14 }} />
                    )}
                  </div>
                  <div style={{ flex: 1, paddingBottom: 9 }}>
                    <div style={{ fontSize: 11, fontWeight: isDelay ? 700 : 600, color: isDelay ? c.danger.text : c.textPrimary }}>
                      {ms.event}
                    </div>
                    <div style={{ fontSize: 11, color: c.textMuted }}>{ms.location} · {fmtEta(ms.at)}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {mv.resolution ? (
          <div>
            <SectionLabel>Outcome</SectionLabel>
            <ResolutionOutcome resolution={mv.resolution} />
          </div>
        ) : late ? (
          <div style={{
            fontSize: 11, color: c.textSecondary, lineHeight: 1.55,
            background: c.warning.bg, border: `1px solid ${c.warning.border}`,
            borderRadius: 7, padding: '9px 11px',
          }}>
            <b>{(mv.options ?? []).filter((o: any) => o.available).length} option(s)</b> available for this
            consignment — on the map card for {mv.movement_ref}.
          </div>
        ) : (
          <EmptyNote>Running to promise — nothing to decide.</EmptyNote>
        )}

        {mv.linked_engineer_code && (
          <button
            onClick={() => onSelectEngineer(mv.linked_engineer_code)}
            // A detail view keeps the full-width button — it is the way OUT of
            // this record, not a tertiary link inside a card — but it now wears
            // the same accent and the same chevron as the card links, so the two
            // read as one family at two sizes instead of two unrelated controls.
            style={{
              marginTop: 12, width: '100%', fontSize: 11.5, fontWeight: 700, padding: '9px 10px',
              borderRadius: 7, cursor: 'pointer', background: c.accentSubtle, color: c.accentText,
              border: `1px solid ${c.accentSolid}33`, display: 'flex', alignItems: 'center',
              justifyContent: 'center', gap: 4,
            }}
          >
            Open {mv.linked_engineer_name}'s van <ChevronRight size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Vehicle detail ──────────────────────────────────────────────────────────

function VehicleDetail({
  v, route, onBack, onWalkaround, onResolveDefect, walkaroundPending, etaRisk,
}: any) {
  const { c } = useTheme()
  const sc = vanTone(c, v.job_status).solid
  const openDefects = v.defects.filter((d: any) => d.status === 'open')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <DetailHeader onBack={onBack}>
        {v.vor ? (
          <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', padding: '2px 9px', borderRadius: 20, background: 'var(--status-danger-bg)', color: 'var(--status-danger-text)' }}>
            Vehicle Off Road
          </span>
        ) : (
          <DetailBadge tone={sc}>{STATUS_LABEL[v.job_status] || v.job_status}</DetailBadge>
        )}
      </DetailHeader>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {/* Identity */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--clt-grey-900)', marginBottom: 2, fontFamily: 'monospace' }}>{v.registration}</div>
          <div style={{ fontSize: 12, color: 'var(--clt-grey-500)', marginBottom: 8 }}>{v.make_model} · {v.mileage.toLocaleString()} miles</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Chip>{v.engineer_name}</Chip>
            <Chip>{v.region}</Chip>
            {v.fuel_type === 'ev'
              ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 20, background: 'var(--status-success-bg)', color: 'var(--status-success-text)', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Zap size={10} /> Electric</span>
              : <Chip>{v.euro_status}</Chip>}
            {v.caz_compliant
              ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 20, background: 'var(--status-success-bg)', color: 'var(--status-success-text)' }}>CAZ ✓</span>
              : <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 20, background: '#FFEDD5', color: 'var(--accent-text)' }}>CAZ charges apply</span>}
          </div>
        </div>

        {/* Arrival risk — the reason this van is worth opening today. It sits
            above the route, because the route below it is what is at stake, and
            it carries its own options: the list is not the only place a
            dispatcher is allowed to decide. */}
        {etaRisk && etaRisk.status === 'open' && <ArrivalRiskBlock risk={etaRisk} />}
        {etaRisk && etaRisk.status === 'resolved' && (
          <div style={{ marginBottom: 16 }}>
            <SectionLabel>Arrival Risk</SectionLabel>
            <ResolutionOutcome resolution={etaRisk.resolution} />
          </div>
        )}

        {/* EV charge */}
        {v.fuel_type === 'ev' && (
          <MetricTip label="EV Charge" title="EV charge & range" block>
            <div style={{ marginBottom: 16, background: 'var(--status-success-bg)', border: '1px solid var(--status-success-border)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                <span style={{ fontWeight: 700, color: 'var(--status-success-text)' }}>⚡ {v.ev_charge_pct}% charge</span>
                <span style={{ color: 'var(--clt-grey-500)' }}>~{v.ev_range_miles} mi range</span>
              </div>
              <div style={{ height: 6, background: 'var(--status-success-bg)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${v.ev_charge_pct}%`, background: v.ev_charge_pct < 35 ? '#F59E0B' : '#10B981', borderRadius: 3 }} />
              </div>
            </div>
          </MetricTip>
        )}

        {/* Today's route */}
        {route?.stops && (
          <div style={{ marginBottom: 16 }}>
            {/* Blocked stops are excluded from the denominator: "2/2 done" while
                a third job sits unattended would read as a finished round. */}
            <SectionLabel>
              Today's Route — {route.stops_completed}/{route.stops_total - (route.stops_blocked ?? 0)} stops done
              {route.stops_blocked > 0 && ` · ${route.stops_blocked} to reallocate`}
            </SectionLabel>
            {route.optimization_applied && (
              <div style={{
                background: 'var(--status-success-bg)', border: '1px solid var(--status-success-border)', borderRadius: 8,
                padding: '8px 11px', marginBottom: 8, fontSize: 11, color: 'var(--status-success-text)', lineHeight: 1.5,
              }}>
                <b>AI-optimized:</b> {route.planned_travel_mins} → {route.optimized_travel_mins} min travel
                (−{route.mins_saved} min, −{route.miles_saved} mi, £{route.fuel_saved_gbp} fuel)
              </div>
            )}
            {/* The block above is the day as planned at first light. This is the
                same optimiser re-run against where the van is NOW, in the traffic
                that is on the road now — which is a different problem and often
                has a different answer. */}
            <LiveReoptimise engineerCode={v.engineer_code} />
            {route.road_route?.available && (
              <div style={{
                background: route.road_route.traffic_delay_mins > 10 ? '#FFFBEB' : 'var(--clt-grey-50)',
                border: `1px solid ${route.road_route.traffic_delay_mins > 10 ? '#FDE68A' : 'var(--clt-grey-200)'}`,
                borderRadius: 8, padding: '8px 11px', marginBottom: 8, fontSize: 11, lineHeight: 1.6,
              }}>
                <div style={{ fontWeight: 700, color: 'var(--clt-grey-700)' }}>
                  🛣 {route.road_route.distance_miles} mi remaining by road · ~{route.road_route.base_duration_mins} min
                  {route.road_route.traffic_delay_mins > 0 && (
                    <span style={{ color: 'var(--status-warning-text)' }}> +{route.road_route.traffic_delay_mins} min traffic</span>
                  )}
                </div>
                {route.road_route.incidents.map((inc: any, i: number) => (
                  <div key={i} style={{ color: 'var(--clt-grey-500)', fontSize: 11, marginTop: 2 }}>
                    {inc.icon} {inc.description}{inc.delay_mins > 0 ? ` (+${inc.delay_mins} min)` : ''}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {route.stops.map((s: any, i: number) => {
                const isCollection = s.stop_kind === 'collection'
                const isBlocked = s.status === 'blocked'
                const color = isBlocked ? '#F59E0B' : isCollection ? '#8B5CF6'
                  : s.status === 'completed' ? '#94A3B8' : s.status === 'next' ? '#F97316' : '#3B82F6'
                return (
                  <div key={s.job_code} style={{ display: 'flex', gap: 10, position: 'relative' }}>
                    {/* timeline */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 20, flexShrink: 0 }}>
                      <div style={{
                        width: 18, height: 18, borderRadius: '50%', background: color,
                        color: '#fff', fontSize: 11, fontWeight: 800,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        opacity: s.status === 'completed' ? 0.55 : 1, zIndex: 1,
                        border: isCollection ? '2px dashed #fff' : undefined,
                      }}>
                        {s.status === 'completed' ? '✓' : isBlocked ? '!' : s.seq}
                      </div>
                      {i < route.stops.length - 1 && (
                        <div style={{ width: 2, flex: 1, background: 'var(--clt-grey-200)', minHeight: 14 }} />
                      )}
                    </div>
                    <div style={{ flex: 1, paddingBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--clt-grey-900)', textTransform: 'capitalize', opacity: s.status === 'completed' ? 0.55 : 1 }}>
                          {s.job_type.replace(/_/g, ' ')}
                        </span>
                        {isCollection && (
                          <span
                            title={`Inserted by ${s.added_by} — ${s.added_reason}`}
                            style={{ fontSize: 11, fontWeight: 800, background: '#8B5CF6', color: '#fff', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' }}
                          >
                            Added
                          </span>
                        )}
                        {s.status === 'next' && (
                          <span style={{ fontSize: 11, fontWeight: 800, background: '#F97316', color: '#fff', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' }}>Next</span>
                        )}
                        {isBlocked && (
                          <span
                            title="This engineer holds no accreditation for this job — it cannot be sequenced and needs reallocating."
                            style={{ fontSize: 11, fontWeight: 800, background: '#F59E0B', color: '#fff', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' }}
                          >
                            Reallocate
                          </span>
                        )}
                        {s.priority && s.priority !== 'standard' && (
                          <span style={{
                            fontSize: 11, fontWeight: 800, borderRadius: 3, padding: '1px 5px',
                            background: s.priority === 'P1' ? '#EF4444' : '#F97316', color: '#fff',
                          }}>{s.priority}</span>
                        )}
                        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: s.status === 'completed' ? 'var(--clt-grey-400)' : color }}>
                          {/* No ETA is quoted for a visit that is not going to
                              happen — what the customer was told is shown instead. */}
                          {isBlocked ? `booked ${s.booked_arrival ?? '—'}` : s.planned_arrival}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--clt-grey-400)', marginTop: 1 }}>
                        {isCollection
                          ? `${s.collection_site_name} · ${(s.sku_codes ?? []).join(', ')} · ${s.service_mins} min`
                          : `${s.job_code} · ${s.postcode} · ${s.service_mins} min on site${s.sla_deadline ? ` · window to ${s.sla_deadline}` : ''}`}
                      </div>
                      {isBlocked && (
                        <div style={{ fontSize: 11, color: 'var(--status-warning-text)', marginTop: 2, fontWeight: 600 }}>
                          Not sequenced — engineer lacks {(s.missing_skill_labels ?? ['the required accreditation']).join(', ')}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Daily walkaround */}
        <div style={{ marginBottom: 16 }}>
          <SectionLabel>DVSA Daily Walkaround</SectionLabel>
          {v.walkaround_completed ? (
            <div style={{ background: 'var(--status-success-bg)', border: '1px solid var(--status-success-border)', borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <ClipboardCheck size={16} color={c.success.text} />
              <div style={{ fontSize: 12, color: 'var(--status-success-text)', fontWeight: 600 }}>Completed at {v.walkaround_time}</div>
            </div>
          ) : (
            <div style={{ background: 'var(--status-ai-bg)', border: '1px solid var(--status-ai-border)', borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={16} color={c.ai.text} />
              <div style={{ flex: 1, fontSize: 12, color: 'var(--status-ai-text)', fontWeight: 600 }}>Not completed today</div>
              <button
                onClick={onWalkaround}
                disabled={walkaroundPending}
                style={{
                  fontSize: 11, fontWeight: 700, padding: '5px 12px', borderRadius: 6,
                  border: 'none', background: '#8B5CF6', color: '#fff', cursor: 'pointer',
                  opacity: walkaroundPending ? 0.6 : 1,
                }}>
                {walkaroundPending ? 'Saving…' : 'Sign Off'}
              </button>
            </div>
          )}
        </div>

        {/* Defects */}
        <div style={{ marginBottom: 16 }}>
          <SectionLabel>Defects ({openDefects.length} open)</SectionLabel>
          {v.defects.length === 0 ? (
            <EmptyNote>No defects reported</EmptyNote>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {v.defects.map((d: any) => (
                <div key={d.defect_id} style={{
                  padding: '9px 11px', borderRadius: 7,
                  background: d.status === 'resolved' ? 'var(--clt-grey-50)' : d.severity === 'major' ? '#FEF2F2' : '#FFFBEB',
                  border: `1px solid ${d.status === 'resolved' ? 'var(--clt-grey-200)' : d.severity === 'major' ? '#FCA5A5' : '#FDE68A'}`,
                  opacity: d.status === 'resolved' ? 0.6 : 1,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{
                      fontSize: 11, fontWeight: 800, textTransform: 'uppercase', padding: '1px 6px', borderRadius: 4,
                      background: d.severity === 'major' ? '#EF4444' : '#F59E0B', color: '#fff',
                    }}>
                      {d.severity}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--clt-grey-400)' }}>{d.defect_id}</span>
                    {d.status === 'resolved'
                      ? <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: 'var(--status-success-text)' }}>RESOLVED</span>
                      : (
                        <button onClick={() => onResolveDefect(d.defect_id)} style={{
                          marginLeft: 'auto', fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 5,
                          border: '1px solid var(--clt-grey-300)', background: 'var(--bg-card)', color: 'var(--clt-grey-600)', cursor: 'pointer',
                        }}>
                          Resolve
                        </button>
                      )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--clt-grey-700)' }}>{d.description}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Servicing */}
        <div style={{ marginBottom: 16 }}>
          <SectionLabel>Servicing & MOT</SectionLabel>
          <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px' } as React.CSSProperties}>
            {[
              // Per-VEHICLE measures. "MOT Due" here is this van's days remaining,
              // not the fleet-wide "MOT Due 30d" count it used to borrow.
              { label: 'MOT Due', val: `${v.mot_due_days}d`, sub: v.mot_due_date, alert: v.mot_due_days <= 30, icon: <Clock size={13} /> },
              { label: 'Service In', val: `${v.service_due_miles.toLocaleString()} mi`, sub: null, alert: v.service_due_miles < 1000, icon: <Wrench size={13} /> },
            ].map(({ label, val, sub, alert, icon }) => (
              <MetricTip key={label} label={label} title={label} block>
                <div style={{
                  background: alert ? '#FEF2F2' : 'var(--clt-grey-50)',
                  border: `1px solid ${alert ? '#FCA5A5' : 'var(--clt-grey-100)'}`,
                  borderRadius: 7, padding: '9px 11px',
                }}>
                  <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: alert ? '#EF4444' : 'var(--clt-grey-400)', display: 'flex' }} aria-hidden="true">{icon}</span>
                    {label}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: alert ? '#EF4444' : 'var(--clt-grey-900)' }}>{val}</div>
                  {sub && <div style={{ fontSize: 11, color: 'var(--clt-grey-400)' }}>{sub}</div>}
                </div>
              </MetricTip>
            ))}
          </div>
        </div>

        {/* Telematics */}
        <div style={{ marginBottom: 16 }}>
          <SectionLabel>Telematics — Last 7 Days</SectionLabel>
          <div style={{ background: 'var(--clt-grey-50)', borderRadius: 8, padding: '11px 13px', marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <MetricTip label="Driver Score">
                <span style={{ fontSize: 11, color: 'var(--clt-grey-600)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Gauge size={12} /> Driver Score
                </span>
              </MetricTip>
              <span style={{ fontSize: 18, fontWeight: 900, color: scoreColor(c, v.driver_score) }}>{v.driver_score}</span>
            </div>
            <div style={{ height: 5, background: 'var(--clt-grey-200)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${v.driver_score}%`, background: scoreColor(c, v.driver_score), borderRadius: 3 }} />
            </div>
          </div>
          <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px' } as React.CSSProperties}>
            {[
              { label: 'Harsh Braking', val: v.harsh_braking_7d, alert: v.harsh_braking_7d > 8 },
              { label: 'Speeding Events', val: v.speeding_events_7d, alert: v.speeding_events_7d > 3 },
              { label: 'Idling', val: `${v.idling_pct}%`, alert: v.idling_pct > 12 },
              { label: 'Driven Today', val: `${v.hours_driven_today}h / ${v.miles_today}mi`, alert: v.hours_driven_today > 4 },
            ].map(({ label, val, alert }) => (
              // Each of these is an input to the Driver Score above, so each says
              // what it weighs as well as what it counts.
              <MetricTip key={label} label={label} title={label} block>
                <div style={{
                  background: alert ? '#FFFBEB' : 'var(--clt-grey-50)',
                  border: `1px solid ${alert ? '#FDE68A' : 'var(--clt-grey-100)'}`,
                  borderRadius: 7, padding: '9px 11px', height: '100%',
                }}>
                  <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: alert ? '#D97706' : 'var(--clt-grey-900)' }}>{val}</div>
                </div>
              </MetricTip>
            ))}
          </div>
        </div>

        {/* Running costs */}
        <div>
          <SectionLabel>Running Costs — This Month</SectionLabel>
          <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px' } as React.CSSProperties}>
            <MetricTip label="Vehicle Fuel Cost" title={v.fuel_type === 'ev' ? 'Charging' : 'Fuel'} block>
              <div style={{ background: 'var(--clt-grey-50)', border: '1px solid var(--clt-grey-100)', borderRadius: 7, padding: '9px 11px', height: '100%' }}>
                <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 2 }}>{v.fuel_type === 'ev' ? 'Charging' : 'Fuel'}</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--clt-grey-900)' }}>£{v.fuel_cost_month_gbp}</div>
              </div>
            </MetricTip>
            <MetricTip label="Tailpipe CO₂" title="Tailpipe CO₂" block>
              <div style={{ background: 'var(--clt-grey-50)', border: '1px solid var(--clt-grey-100)', borderRadius: 7, padding: '9px 11px', height: '100%' }}>
                <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginBottom: 2 }}>Tailpipe CO₂</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: v.co2_kg_month === 0 ? '#10B981' : 'var(--clt-grey-900)' }}>
                  {v.co2_kg_month === 0 ? 'Zero' : `${v.co2_kg_month} kg`}
                </div>
              </div>
            </MetricTip>
          </div>
        </div>
      </div>
    </div>
  )
}
