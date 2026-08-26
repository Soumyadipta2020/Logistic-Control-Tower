import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { usePermissions } from '../hooks/usePermissions'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '../components/ui/PageHeader'
import { ActionedToday } from '../components/ui/ResolutionPanel'
import { ColTooltip } from '../components/ui/ColTooltip'
import { MetricTip } from '../components/ui/InfoTooltip'
import {
  fetchDemandSignals, fetchInventory, fetchInventorySummary, fetchInventoryItem,
  fetchReplenishmentOrders, fetchHeatPumpPipeline,
  fetchSmartMeterDashboard, fetchSkuForecast,
  createReplenishmentOrder, api,
  fetchDemandNetwork, createDisposition,
  fetchTransferOrders, createTransferOrder,
  receivePurchaseOrder, receiveTransfer, expeditePurchaseOrder,
} from '../lib/api'
import {
  PlaneHeader, StateOfNetworkBand, PlannerWorklist,
  MeioCard, SopAllocationCard, ReplenishmentRoutingCard,
  ProgrammePolicyDrivers,
  ScenarioTwinCard, InventoryHealthCard, ForecastWaterfall, SafetyStockExplainer,
  HelpTip, TablePager, MiniSelect,
} from '../components/demand/Workspaces'
import { useReferenceData } from '../components/demand/useReferenceData'
import {
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area,
  ComposedChart, Bar, Line, ReferenceLine,
} from 'recharts'
import {
  AlertTriangle, PackageX, CalendarDays, CheckCircle, FileText, Zap,
  Thermometer, ClipboardList, Check, X, Factory, Warehouse,
  ArrowRight, ArrowLeftRight, Truck,
  LayoutGrid, Activity, PoundSterling, SlidersHorizontal, TrendingUp,
  Boxes, CalendarRange, PackageCheck, TrendingDown, Info, ClipboardCheck,
} from 'lucide-react'

// ─── constants ────────────────────────────────────────────────────────────────

const RAG_COLOR: Record<string, string> = { G: '#10B981', A: '#F59E0B', R: '#EF4444' }
const RAG_LABEL: Record<string, string> = { G: 'Adequate', A: 'Low Stock', R: 'Critical' }


const PO_TYPE_LABEL: Record<string, string> = {
  standard: 'Standard', emergency: 'Emergency', auto_replenishment: 'Auto',
}

const DISPOSITION_TEXT: Record<string, string> = {
  return_to_vendor: 'returned to vendor', markdown: 'marked down', rebalance: 'rebalanced', write_off: 'written off',
}



type Scope = string   // site code from the engine, or 'NETWORK'

const TRANSFER_STATUS_LABEL: Record<string, string> = {
  requested: 'Requested', picking: 'Picking', in_transit: 'In Transit', delivered: 'Delivered',
}

// Scoping to a site, filtering, sorting and paging all happen server-side now —
// the client never holds the full catalogue, so the page stays responsive at
// 1000+ SKUs and the aggregates stay correct regardless of the page on screen.

const ABC_COLOR: Record<string, string> = { A: '#DC2626', B: '#D97706', C: '#2563EB' }

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'risk', label: 'Risk (critical first)' },
  { value: 'days_of_supply', label: 'Days cover ↑' },
  { value: '-stock_value_gbp', label: 'Stock value ↓' },
  { value: '-quantity_available', label: 'Available ↓' },
  { value: 'sku_code', label: 'SKU code A–Z' },
  { value: 'segment', label: 'Segment' },
]
const RAG_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'R', label: 'Critical only' },
  { value: 'A', label: 'Low stock only' },
  { value: 'G', label: 'Adequate only' },
]

function fmtGBP(v: number): string {
  if (v >= 1_000_000) return `£${(v / 1_000_000).toFixed(1)}m`
  if (v >= 1_000) return `£${(v / 1_000).toFixed(0)}k`
  return `£${Math.round(v)}`
}


// ─── main page ───────────────────────────────────────────────────────────────

export function DemandPage() {
  const refData = useReferenceData()
  const { c } = useTheme()
  const { can } = usePermissions()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [scope, setScope] = useState<Scope>('NETWORK')
  // The page's plane structure (Worklist → Position → Execute → Orchestrate →
  // Programmes) is long enough to scroll for minutes, so it's tabbed rather than
  // stacked.
  type SubTab = 'worklist' | 'position' | 'execute' | 'orchestrate' | 'programmes'
  const [subTab, setSubTab] = useState<SubTab>('worklist')
  const [catFilter, setCatFilter] = useState<string>('all')
  const [segFilter, setSegFilter] = useState<string>('all')
  const [ragFilter, setRagFilter] = useState<string>('all')
  const [sort, setSort] = useState<string>('risk')
  const [search, setSearch] = useState<string>('')
  const [debouncedSearch, setDebouncedSearch] = useState<string>('')
  const [page, setPage] = useState(1)
  const PER_PAGE = 25
  const [drillTab, setDrillTab] = useState<'projection' | 'forecast'>('projection')
  const [selectedSku, setSelectedSku] = useState<string | null>(null)
  const [supplierFilter, setSupplierFilter] = useState<string | null>(null)
  const [poPage, setPoPage] = useState(1)
  const [poStatus, setPoStatus] = useState('all')
  const [stoPage, setStoPage] = useState(1)
  const [stoStatus, setStoStatus] = useState('all')
  const QUEUE_PER = 10
  const [raisePOSku, setRaisePOSku] = useState<string | null>(null)
  const [transferReq, setTransferReq] = useState<{ sku: string; toCode?: string; fromCode?: string; qty?: number } | null>(null)
  const [lastCreatedPO, setLastCreatedPO] = useState<string | null>(null)
  const [lastCreatedTransfer, setLastCreatedTransfer] = useState<string | null>(null)
  // In-place notification shown inside the Planner Worklist card (no page scroll)
  const [worklistNotice, setWorklistNotice] = useState<{ tone: 'success' | 'info' | 'error'; text: string } | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notify = useCallback((tone: 'success' | 'info' | 'error', text: string) => {
    setWorklistNotice({ tone, text })
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setWorklistNotice(null), 6000)
  }, [])
  const queryClient = useQueryClient()

  // Debounce the search box so typing doesn't fire a request per keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  // Any filter change returns to page 1
  useEffect(() => { setPage(1) }, [debouncedSearch, catFilter, segFilter, ragFilter, sort, scope])
  useEffect(() => { setPoPage(1) }, [supplierFilter, poStatus])
  useEffect(() => { setStoPage(1) }, [stoStatus])
  // Orchestrate/Programmes only have content at Whole Network scope — bounce off
  // them if a site gets scoped while one's open, rather than leave an empty tab active.
  useEffect(() => {
    if ((subTab === 'orchestrate' || subTab === 'programmes') && scope !== 'NETWORK') setSubTab('worklist')
  }, [scope, subTab])

  // Deep-link entry from other modules. Params are consumed after landing so a
  // refresh or back-navigation doesn't re-trigger the focus:
  //   ?sku=SKU-…      Exceptions / IoT → that SKU's position + drill-in
  //   ?sku=…&tab=forecast  Forecast Tuning chart → straight to Forecast & Quality
  //   ?scope=LEI_COE  Live Visibility hub detail → that site's stock scope
  //   ?supplier=MIT_HV Supplier Risk → the PO queue filtered to that supplier
  useEffect(() => {
    const sku = searchParams.get('sku')
    const tab = searchParams.get('tab')
    const scopeParam = searchParams.get('scope')
    const supplier = searchParams.get('supplier')
    if (!sku && !scopeParam && !supplier) return
    if (sku) {
      setSearch(sku)
      setDebouncedSearch(sku)
      setSelectedSku(sku)
      setDrillTab(tab === 'forecast' ? 'forecast' : 'projection')
      setSubTab('position')
    }
    if (scopeParam) setScope(scopeParam as Scope)
    if (supplier) {
      setSupplierFilter(supplier)
      // The PO queue only renders at Whole Network / NDC scope — force it so the
      // deep link always lands somewhere the queue actually exists.
      if (!scopeParam) setScope('NETWORK')
      setSubTab('execute')
      setTimeout(() => document.getElementById('po-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250)
    }
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams])

  const createPOMutation = useMutation({
    mutationFn: createReplenishmentOrder,
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['replenishment-orders'] })
      queryClient.invalidateQueries({ queryKey: ['planner-worklist'] })
      queryClient.invalidateQueries({ queryKey: ['demand-network'] })
      setRaisePOSku(null)
      setLastCreatedPO(created?.po_number || null)
      setTimeout(() => setLastCreatedPO(null), 8000)
    },
  })

  const createTransferMutation = useMutation({
    mutationFn: createTransferOrder,
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['transfer-orders'] })
      queryClient.invalidateQueries({ queryKey: ['planner-worklist'] })
      queryClient.invalidateQueries({ queryKey: ['demand-network'] })
      setTransferReq(null)
      setLastCreatedTransfer(created?.transfer_id || null)
      setTimeout(() => setLastCreatedTransfer(null), 8000)
    },
  })

  const receivePOMutation = useMutation({
    mutationFn: receivePurchaseOrder,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['replenishment-orders'] })
      queryClient.invalidateQueries({ queryKey: ['inventory'] })
      queryClient.invalidateQueries({ queryKey: ['planner-worklist'] })
      queryClient.invalidateQueries({ queryKey: ['demand-network'] })
      queryClient.invalidateQueries({ queryKey: ['demand-financials'] })
    },
  })

  // Expedite an EXISTING in-flight PO (from the worklist expedite action) — not a
  // new order. Confirms in place in the worklist rather than scrolling the page.
  const expeditePOMutation = useMutation({
    mutationFn: expeditePurchaseOrder,
    onSuccess: (po) => {
      queryClient.invalidateQueries({ queryKey: ['replenishment-orders'] })
      queryClient.invalidateQueries({ queryKey: ['planner-worklist'] })
      queryClient.invalidateQueries({ queryKey: ['demand-network'] })
      notify('success', po?.po_number ? `${po.po_number} expedited — ETA pulled in to 2 days` : 'PO expedited')
    },
    onError: () => notify('error', 'Could not expedite that PO — please retry'),
  })

  // Apply an excess disposition straight from the worklist (return to vendor /
  // mark down / rebalance) — the recommended fix, done in place.
  const dispositionMutation = useMutation({
    mutationFn: (v: { sku_code: string; action: string }) => createDisposition(v),
    onSuccess: (_res, v) => {
      queryClient.invalidateQueries({ queryKey: ['excess-dispositions'] })
      queryClient.invalidateQueries({ queryKey: ['planner-worklist'] })
      queryClient.invalidateQueries({ queryKey: ['demand-financials'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-summary'] })
      notify('success', `${v.sku_code} — ${DISPOSITION_TEXT[v.action] ?? 'disposition'} applied`)
    },
    onError: () => notify('error', 'Could not apply that disposition — please retry'),
  })

  const receiveTransferMutation = useMutation({
    mutationFn: receiveTransfer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transfer-orders'] })
      queryClient.invalidateQueries({ queryKey: ['planner-worklist'] })
      queryClient.invalidateQueries({ queryKey: ['demand-network'] })
    },
  })

  // Query sent to the server for the table page and (minus rag/page) for the aggregates
  const scopeParam = scope === 'NETWORK' ? undefined : scope
  const listQuery = {
    page, per_page: PER_PAGE, search: debouncedSearch, sku_category: catFilter,
    segment: segFilter, rag: ragFilter, sort, warehouse_code: scopeParam,
  }
  const summaryQuery = {
    search: debouncedSearch, sku_category: catFilter, segment: segFilter, warehouse_code: scopeParam,
  }
  // The filters every OTHER card on the page shares, so clicking an ABC/XYZ cell
  // narrows the worklist, planner, MEIO, excess, financials and tuning too.
  const cardScope = useMemo(
    () => ({ segment: segFilter, sku_category: catFilter, warehouse_code: scopeParam }),
    [segFilter, catFilter, scopeParam])

  const { data: signals } = useQuery({ queryKey: ['demand-signals'], queryFn: fetchDemandSignals, refetchInterval: 30_000 })
  const { data: inventory, isFetching: invFetching } = useQuery({
    queryKey: ['inventory', listQuery],
    queryFn: () => fetchInventory(listQuery),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,   // keep rows on screen while paging
  })
  const { data: summary } = useQuery({
    queryKey: ['inventory-summary', summaryQuery],
    queryFn: () => fetchInventorySummary(summaryQuery),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  })
  const { data: network } = useQuery({ queryKey: ['demand-network'], queryFn: fetchDemandNetwork, refetchInterval: 30_000 })
  const { data: transfers, isFetching: stoFetching } = useQuery({
    queryKey: ['transfer-orders', stoPage, stoStatus, scope],
    queryFn: () => fetchTransferOrders(stoStatus === 'all' ? undefined : stoStatus, stoPage, QUEUE_PER,
      isHubScope ? scope : undefined),
    refetchInterval: 30_000, placeholderData: (prev) => prev,
  })
  const { data: orders, isFetching: poFetching } = useQuery({
    queryKey: ['replenishment-orders', supplierFilter, poPage, poStatus],
    queryFn: () => fetchReplenishmentOrders(poStatus === 'all' ? undefined : poStatus, supplierFilter ?? undefined, poPage, QUEUE_PER),
    refetchInterval: 30_000, placeholderData: (prev) => prev,
  })
  const { data: autoPO } = useQuery({ queryKey: ['auto-po'], queryFn: async () => { const r = await api.get('/api/v1/demand/auto-po'); return r.data.data }, refetchInterval: 30_000 })
  const { data: hpPipeline } = useQuery({ queryKey: ['heat-pump-pipeline'], queryFn: fetchHeatPumpPipeline, refetchInterval: 60_000 })
  const { data: smDash } = useQuery({ queryKey: ['smart-meter-dashboard'], queryFn: fetchSmartMeterDashboard, refetchInterval: 60_000 })
  const { data: skuForecast } = useQuery({
    queryKey: ['sku-forecast', selectedSku],
    queryFn: () => fetchSkuForecast(selectedSku!),
    enabled: !!selectedSku,
  })
  // Full detail (sites, forecast quality, drivers) only for the expanded row
  const { data: skuDetail } = useQuery({
    queryKey: ['inventory-item', selectedSku, scope],
    queryFn: () => fetchInventoryItem(selectedSku!, scopeParam),
    enabled: !!selectedSku,
  })
  // …and for whichever SKU a modal is acting on
  const modalSku = raisePOSku || transferReq?.sku || null
  const { data: modalItem } = useQuery({
    queryKey: ['inventory-item', modalSku, scope],
    queryFn: () => fetchInventoryItem(modalSku!, scopeParam),
    enabled: !!modalSku,
  })

  const items = useMemo<any[]>(() => inventory?.items ?? [], [inventory])
  const totalRows = inventory?.total ?? 0
  const totalPages = inventory?.pages ?? 1
  const catalogueSize = summary?.catalogue_size ?? inventory?.catalogue_size ?? 0

  const poItems = useMemo<any[]>(() => orders?.items ?? [], [orders])
  const transferItems = useMemo<any[]>(() => transfers?.items ?? [], [transfers])
  const openTransfers = useMemo(() => transferItems.filter((t: any) => t.status !== 'delivered'), [transferItems])
  const scopeTransfers = transferItems

  const isHubScope = scope !== 'NETWORK' && scope !== refData.ndcCode

  // KPIs come from the server aggregate so they describe the WHOLE filtered
  // catalogue, not just the page of rows currently loaded.
  const atRisk = summary?.at_risk ?? 0
  const stockouts = summary?.stockouts ?? 0
  const avgDoS = summary?.avg_days_of_supply ?? 0
  const fillRate = summary?.fill_rate_pct ?? 100
  const scopedCount = summary?.count ?? 0
  const openPOValue = useMemo(() => poItems.reduce((s: number, o: any) => s + (o.total_value_gbp || 0), 0), [poItems])
  const emergencyPOs = useMemo(() => poItems.filter((o: any) => o.po_type === 'emergency').length, [poItems])

  const scopeLabel = scope === 'NETWORK' ? 'across the network' : `at ${refData.siteName[scope]}`

  // Inbound supply for the projection panel, matched to the current scope:
  // network/NDC views project against inbound supplier POs; a hub view projects
  // against inbound trunker transfers from the NDC.
  const inboundsForSku = useCallback((sku: string): { dayOffset: number; qty: number; label: string }[] => {
    const now = Date.now()
    if (isHubScope) {
      return openTransfers
        .filter((t: any) => t.sku_code === sku && t.to_warehouse === scope && t.quantity)
        .map((t: any) => ({
          dayOffset: Math.max(0, Math.ceil((new Date(t.expected_arrival).getTime() - now) / 86400000)),
          qty: t.quantity, label: t.transfer_id,
        }))
    }
    return poItems
      .filter((p: any) => p.sku_code === sku && p.quantity && ['draft', 'confirmed', 'in_transit'].includes(p.status))
      .map((p: any) => ({
        dayOffset: Math.max(0, Math.ceil((new Date(p.expected_delivery).getTime() - now) / 86400000)),
        qty: p.quantity, label: p.po_number,
      }))
  }, [poItems, openTransfers, scope, isHubScope])

  // ── Stable callbacks — prevent child row re-renders from new function refs.
  // Modals now act on a SKU code; the full position is fetched on demand, so we
  // never need the whole catalogue client-side.
  const handleSelectSku = useCallback((sku: string) => { setSelectedSku(s => s === sku ? null : sku); setDrillTab('projection') }, [])
  const handleRaisePO = useCallback((sku: string) => setRaisePOSku(sku), [])
  const handleCloseModal = useCallback(() => setRaisePOSku(null), [])
  const handleCloseTransfer = useCallback(() => setTransferReq(null), [])

  // Supplier picker for the PO queue — sourced from the engine's supplier master,
  // ordered by how many POs each actually has so the busy ones surface first.
  const supplierOptions = useMemo(
    () => [...(refData.suppliers ?? [])].sort(
      (a: any, b: any) => (b.po_count ?? 0) - (a.po_count ?? 0) || a.name.localeCompare(b.name)),
    [refData.suppliers])
  const supplierName = useCallback(
    (code: string) => refData.suppliers.find((x: any) => x.code === code)?.name ?? code,
    [refData.suppliers])

  // Worklist "Action →" — every kind lands on the action that resolves it, and
  // the action MATCHES the recommendation: expedite pulls in the existing
  // in-flight PO (never raises a new one); a purchase or the generic
  // stockout/low-stock fallback opens the raise-PO modal; a transfer/rebalance
  // opens the transfer modal pre-filled with the route and quantity the DRP
  // engine worked out; a supplier risk deep-links to that supplier's scorecard
  // drawer on the Risk module; excess scrolls to the Excess & Obsolescence card
  // where its disposition is applied.
  const handleWorklistAct = useCallback((wi: any) => {
    if (wi.kind === 'supplier') navigate(`/risk?supplier=${encodeURIComponent(wi.sku_code)}`)
    else if (wi.kind === 'expedite') {
      // Expedite the specific in-flight PO the recommendation named; only fall
      // back to raising a new order if that PO can't be identified.
      if (wi.po_number) expeditePOMutation.mutate(wi.po_number)
      else setRaisePOSku(wi.sku_code)
    }
    else if (wi.kind === 'excess') {
      // Apply the recommended disposition in place — the exact fix the button names.
      dispositionMutation.mutate({ sku_code: wi.sku_code, action: wi.disposition })
    }
    else if (wi.kind === 'purchase' || wi.kind === 'stockout' || wi.kind === 'low_stock') setRaisePOSku(wi.sku_code)
    else if (wi.kind === 'transfer' || wi.kind === 'rebalance') setTransferReq({ sku: wi.sku_code, toCode: wi.to_code, fromCode: wi.from_code, qty: wi.quantity })
    else { setSelectedSku(wi.sku_code); setDrillTab('projection') }
  }, [navigate, expeditePOMutation, dispositionMutation])

  return (
    <>
      <PageHeader
        title="Demand & Inventory Control Tower"
        subtitle="Position → Execute → Orchestrate → Learn · a closed-loop planning engine · suppliers → Leicester NDC → regional hubs"
      />
      <div className="page-body">

        {/* ── Scope selector ─────────────────────────────────────────────────── */}
        <div data-tour="dem-scope" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: c.textMuted }}>
            Viewing stock at
          </span>
          {refData.scopes.map(s => {
            const active = scope === s.code
            // Site health comes from the server aggregate — no client-side scan
            const siteAtRisk = s.code === 'NETWORK'
              ? 0
              : (summary?.sites ?? []).find((x: any) => x.warehouse_code === s.code)?.at_risk ?? 0
            return (
              <button
                key={s.code}
                onClick={() => { setScope(s.code); setSelectedSku(null) }}
                style={{
                  fontSize: 12, fontWeight: 700, padding: '6px 14px', borderRadius: 20, cursor: 'pointer',
                  background: active ? '#2563EB' : c.surface,
                  color: active ? '#fff' : c.textSecondary,
                  border: `1px solid ${active ? '#2563EB' : c.border}`,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                {s.code === 'NETWORK' ? <ArrowLeftRight size={12} /> : <Warehouse size={12} />}
                {s.label}
                {s.code === refData.ndcCode && <span style={{ fontSize: 11, fontWeight: 800, padding: '1px 5px', borderRadius: 8, background: active ? 'rgba(255,255,255,0.25)' : c.chipBg, color: active ? '#fff' : c.chipText }}>PRIMARY</span>}
                {siteAtRisk > 0 && !active && (
                  <span style={{ fontSize: 11, fontWeight: 800, minWidth: 14, textAlign: 'center', padding: '1px 4px', borderRadius: 10, background: 'var(--status-danger-bg)', color: 'var(--status-danger-text)' }}>{siteAtRisk}</span>
                )}
              </button>
            )
          })}
        </div>

        {/* A page-wide filter changes every number below it, so say so plainly. */}
        {(segFilter !== 'all' || catFilter !== 'all') && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap',
            padding: '7px 12px', marginBottom: 10, borderRadius: 8,
            background: c.info.bg, border: `1px solid ${c.info.border}`,
          }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: c.info.text, letterSpacing: '0.04em' }}>FILTERED</span>
            <span style={{ fontSize: 11.5, color: c.textPrimary }}>
              Every metric and table below is scoped to
              {segFilter !== 'all' && <> segment <b>{segFilter}</b></>}
              {segFilter !== 'all' && catFilter !== 'all' && ' ·'}
              {catFilter !== 'all' && <> category <b>{refData.catLabels[catFilter] ?? catFilter}</b></>}
              {scope !== 'NETWORK' && <> at <b>{refData.siteName[scope] ?? scope}</b></>}
            </span>
            <button
              onClick={() => { setSegFilter('all'); setCatFilter('all') }}
              style={{
                marginLeft: 'auto', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 6,
                cursor: 'pointer', background: c.surface, color: c.info.text, border: `1px solid ${c.info.border}`,
              }}
            >
              Clear filters
            </button>
          </div>
        )}

        {/* ── State of Network (cockpit summary) ─────────────────────────────── */}
        <div data-tour="dem-network-band">
          <StateOfNetworkBand atRisk={atRisk} stockouts={stockouts} scope={cardScope} />
        </div>

        {/* ── KPI Cards ──────────────────────────────────────────────────────── */}
        <div data-tour="dem-kpis" className="auto-grid" style={{ '--cols': '6', '--col-min': '158px', '--grid-gap': '10px', marginBottom: 12 } as React.CSSProperties}>
          <DemandKpiCard
            icon={AlertTriangle}
            label="SKUs at Risk"
            value={String(atRisk)}
            sub={`${(scopedCount - atRisk).toLocaleString()} of ${scopedCount.toLocaleString()} SKUs adequate ${scopeLabel}`}
            rag={atRisk > scopedCount * 0.08 ? 'R' : atRisk > 0 ? 'A' : 'G'}
            progress={scopedCount ? ((scopedCount - atRisk) / scopedCount) * 100 : 100}
          />
          <DemandKpiCard
            icon={PackageX}
            label="Active Stockouts"
            value={String(stockouts)}
            sub={stockouts === 0 ? `All SKUs have stock ${scopeLabel}` : `SKU${stockouts !== 1 ? 's' : ''} at zero available ${scopeLabel}`}
            rag={stockouts > 0 ? 'R' : 'G'}
          />
          <DemandKpiCard
            icon={CalendarDays}
            label="Avg Days of Cover"
            value={`${avgDoS.toFixed(1)}d`}
            sub={`inventory coverage ${scopeLabel}`}
            rag={avgDoS < 5 ? 'R' : avgDoS < 10 ? 'A' : 'G'}
          />
          <DemandKpiCard
            icon={CheckCircle}
            label="Fill Rate"
            value={`${fillRate.toFixed(1)}%`}
            sub={`SKUs at/above safety stock ${scopeLabel}`}
            rag={fillRate >= 95 ? 'G' : fillRate >= 85 ? 'A' : 'R'}
            progress={fillRate}
          />
          {isHubScope ? (
            <DemandKpiCard
              icon={Truck}
              label="Inbound Transfers"
              value={String(openTransfers.filter((t: any) => t.to_warehouse === scope).length)}
              sub={`${openTransfers.filter((t: any) => t.to_warehouse === scope).reduce((s: number, t: any) => s + (t.quantity || 0), 0).toLocaleString()} units en route from the NDC`}
              rag="N"
            />
          ) : (
            <DemandKpiCard
              icon={FileText}
              label="Open PO Value"
              value={`£${openPOValue >= 1_000_000 ? `${(openPOValue / 1_000_000).toFixed(1)}m` : `${(openPOValue / 1000).toFixed(0)}k`}`}
              sub={`${poItems.length} supplier PO${poItems.length !== 1 ? 's' : ''} inbound to the NDC`}
              rag="N"
            />
          )}
          {isHubScope ? (
            <DemandKpiCard
              icon={ArrowLeftRight}
              label="Transfer Lead"
              value={`${network?.hubs?.find((h: any) => h.warehouse_code === scope)?.transfer_lead_days ?? 1}d`}
              sub="trunker time on an STO from the NDC"
              rag="N"
            />
          ) : (
            <DemandKpiCard
              icon={Zap}
              label="Emergency POs"
              value={String(emergencyPOs)}
              sub={emergencyPOs === 0 ? 'No emergency orders active' : `of ${poItems.length} total open POs`}
              rag={emergencyPOs > 2 ? 'R' : emergencyPOs > 0 ? 'A' : 'G'}
            />
          )}
        </div>

        {/* ── Network Flow ───────────────────────────────────────────────────── */}
        {network && (
          <div data-tour="dem-flow">
            <NetworkFlowCard network={network} scope={scope} onSelectSite={(code) => { setScope(code as Scope); setSelectedSku(null) }} />
          </div>
        )}

        {/* ── Planner Worklist → Inventory optimisation → Replenishment & fulfilment
            → S&OP/allocation/twin → Programme & Policy Drivers — tabbed so the
            page is a click away instead of minutes of scrolling ───────────── */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap' }}>
          {([
            { key: 'worklist', label: 'Planner Worklist', icon: ClipboardCheck },
            { key: 'position', label: 'Inventory optimisation', icon: Boxes },
            { key: 'execute', label: 'Replenishment & fulfilment', icon: Truck },
            ...(scope === 'NETWORK' ? [
              { key: 'orchestrate' as const, label: 'S&OP, allocation & the network twin', icon: CalendarRange },
              { key: 'programmes' as const, label: 'Programme & Policy Drivers', icon: TrendingUp },
            ] : []),
          ] as { key: SubTab; label: string; icon: React.ElementType }[]).map(t => (
            <button
              key={t.key}
              data-tour={`dem-tab-${t.key}`}
              className={`btn ${subTab === t.key ? 'btn-primary' : 'btn-secondary'} btn-sm`}
              onClick={() => setSubTab(t.key)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <t.icon size={14} /> {t.label}
              </div>
            </button>
          ))}
        </div>

        {/* ── Planner worklist — the cockpit action list ─────────────────────── */}
        {subTab === 'worklist' && (
        <div className="section-gap" data-tour="dem-worklist">
          <PlannerWorklist
            onAct={handleWorklistAct}
            scope={cardScope}
            canAct={can('write:po')}
            notice={worklistNotice}
            onDismissNotice={() => setWorklistNotice(null)}
          />
        </div>
        )}

        {/* ═══════════ POSITION ═══════════ */}
        {subTab === 'position' && (
        <>
        <PlaneHeader
          plane="POSITION"
          tip="Statistical Safety Stock"
          title="Inventory optimisation"
          subtitle="Statistical safety stock · multi-echelon risk pooling · segment-driven policy · excess & obsolescence disposition"
          icon={Boxes}
        />

        {/* ── Portfolio analytics: ABC/XYZ segmentation · MEIO risk pooling ──── */}
        <div className="auto-grid section-gap" style={{ '--cols': '2', '--col-min': '300px', '--grid-gap': '12px' } as React.CSSProperties}>
          {/* Wrappers exist only to carry the tour anchor; `display: grid` keeps
              the card stretched to the cell exactly as it was when it was the
              grid item itself. */}
          <div data-tour="dem-segmentation" style={{ display: 'grid', minWidth: 0 }}>
            <SegmentationCard summary={summary} activeSegment={segFilter} onSelect={(seg) => setSegFilter(s => s === seg ? 'all' : seg)} />
          </div>
          <div data-tour="dem-meio" style={{ display: 'grid', minWidth: 0 }}>
            <MeioCard scope={cardScope} />
          </div>
        </div>

        {/* Health, forecast quality and the tuning loop that drives it — one
            full-width card, since the two used to repeat the same WMAPE/bias */}
        <div className="section-gap" data-tour="dem-health">
          <InventoryHealthCard summary={summary} scopeLabel={scopeLabel} scope={cardScope} />
        </div>

        {/* ── Inventory Positions ─────────────────────────────────────────────── */}
        <div className="card section-gap" data-tour="dem-positions">
          <div className="card-header" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div className="card-title">
                Inventory Positions — {scope === 'NETWORK' ? 'Whole Network' : refData.siteName[scope]}
              </div>
              <div className="card-subtitle">
                {totalRows.toLocaleString()} matching SKU{totalRows !== 1 ? 's' : ''} of {catalogueSize.toLocaleString()} in the catalogue
                {' · '}
                {scope === 'NETWORK'
                  ? 'network totals with per-site health'
                  : scope === refData.ndcCode
                    ? 'NDC positions replenished from suppliers'
                    : 'hub positions replenished from the NDC by trunker transfer'}
                {' · click a row for the site split and demand chart'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') setSearch('') }}
                  placeholder="Search SKU or description…"
                  aria-label="Search inventory by SKU code or description"
                  style={{ fontSize: 13, padding: '5px 26px 5px 10px', borderRadius: 6, minWidth: 210, border: `1px solid ${search ? '#2563EB' : c.border}`, background: c.surface, color: c.textPrimary }}
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    aria-label="Clear search"
                    title="Clear search (Esc)"
                    style={{ position: 'absolute', right: 5, display: 'flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: c.textMuted, padding: 2 }}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
              <select value={ragFilter} onChange={e => setRagFilter(e.target.value)}
                style={{ fontSize: 13, padding: '5px 10px', borderRadius: 6, border: `1px solid ${ragFilter !== 'all' ? '#DC2626' : c.border}`, background: c.surface, color: ragFilter !== 'all' ? '#DC2626' : c.textPrimary, cursor: 'pointer', fontWeight: ragFilter !== 'all' ? 700 : 400 }}>
                {RAG_FILTERS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select value={segFilter} onChange={e => setSegFilter(e.target.value)}
                style={{ fontSize: 13, padding: '5px 10px', borderRadius: 6, border: `1px solid ${segFilter !== 'all' ? '#6D28D9' : c.border}`, background: c.surface, color: segFilter !== 'all' ? '#6D28D9' : c.textPrimary, cursor: 'pointer', fontWeight: segFilter !== 'all' ? 700 : 400 }}>
                <option value="all">All segments</option>
                {(summary?.segments ?? []).map((s: any) => (
                  <option key={s.segment} value={s.segment}>{s.segment} · {s.count.toLocaleString()} SKU{s.count !== 1 ? 's' : ''}</option>
                ))}
              </select>
              <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
                style={{ fontSize: 13, padding: '5px 10px', borderRadius: 6, border: `1px solid ${c.border}`, background: c.surface, color: c.textPrimary, cursor: 'pointer' }}>
                {Object.entries(refData.catLabels).map(([k, v]) => {
                  const stat = k === 'all' ? null : (summary?.categories ?? []).find((x: any) => x.category === k)
                  return (
                    <option key={k} value={k}>
                      {v}{stat ? ` · ${stat.count}${stat.at_risk > 0 ? ` (! ${stat.at_risk})` : ''}` : ''}
                    </option>
                  )
                })}
              </select>
              <select value={sort} onChange={e => setSort(e.target.value)}
                style={{ fontSize: 13, padding: '5px 10px', borderRadius: 6, border: `1px solid ${c.border}`, background: c.surface, color: c.textPrimary, cursor: 'pointer' }}>
                {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          {/* Inventory table */}
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Description</th>
                  <th><ColTooltip label="Seg" lookupKey="Segment" /></th>
                  {scope === 'NETWORK' && <th><ColTooltip label="Site Health" /></th>}
                  <th style={{ textAlign: 'right' }}><ColTooltip label="On Hand" /></th>
                  <th style={{ textAlign: 'right' }}><ColTooltip label="Reserved" /></th>
                  <th style={{ textAlign: 'right' }}><ColTooltip label="Available" /></th>
                  <th style={{ textAlign: 'right' }}><ColTooltip label="Value" lookupKey="Stock Value" /></th>
                  <th style={{ textAlign: 'right' }}><ColTooltip label="Safety Stock" /></th>
                  <th style={{ textAlign: 'right' }}><ColTooltip label="Reorder Pt" lookupKey="Reorder Pt" /></th>
                  <th style={{ textAlign: 'right' }}><ColTooltip label="Days Cover" /></th>
                  <th style={{ textAlign: 'right' }}><ColTooltip label={isHubScope ? 'Transfer Lead' : 'Lead Time'} lookupKey={isHubScope ? 'Transfer Lead' : 'Lead Time'} /></th>
                  <th><ColTooltip label="Status" lookupKey="Stock Status" /></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item: any) => {
                  const isSelected = selectedSku === item.sku_code
                  const needsAction = item.rag_status !== 'G'
                  return (
                    <React.Fragment key={item.sku_code}>
                      <tr
                        onClick={() => handleSelectSku(item.sku_code)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectSku(item.sku_code) }
                        }}
                        tabIndex={0}
                        role="button"
                        aria-expanded={isSelected}
                        aria-label={`${item.sku_code} ${item.description} — ${isSelected ? 'collapse' : 'expand'} detail`}
                        style={{
                          cursor: 'pointer',
                          background: isSelected ? c.info.bg : undefined,
                          borderLeft: `3px solid ${RAG_COLOR[item.rag_status] || '#E5E7EB'}`,
                        }}
                      >
                        <td style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700 }}>{item.sku_code}</td>
                        <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                          {item.description}
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{refData.catLabels[item.category] || item.category}</div>
                        </td>
                        <td><SegmentBadge item={item} /></td>
                        {scope === 'NETWORK' && (
                          <td><SiteDots siteRag={item.site_rag} /></td>
                        )}
                        <td style={{ fontWeight: 600, textAlign: 'right' }}>{item.quantity_on_hand?.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', color: 'var(--text-tertiary)' }}>{item.quantity_reserved?.toLocaleString()}</td>
                        <td style={{ fontWeight: 700, textAlign: 'right', color: item.quantity_available === 0 ? '#EF4444' : 'inherit' }}>
                          {item.quantity_available?.toLocaleString()}
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>{fmtGBP(item.stock_value_gbp || 0)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--text-tertiary)' }}>{item.safety_stock_level?.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', color: 'var(--text-tertiary)' }}>{item.reorder_point?.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: item.days_of_supply < (item.lead_time_days ?? 3) ? '#EF4444' : item.days_of_supply < ((item.lead_time_days ?? 3) + (item.review_period_days ?? 7)) ? '#F59E0B' : 'inherit' }}>
                          {item.days_of_supply > 900 ? '—' : `${item.days_of_supply?.toFixed(1)}d`}
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-tertiary)' }}>
                          {item.lead_time_days != null ? `${item.lead_time_days}d` : '—'}
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <StatusBadge item={item} />
                            {item.is_excess && (
                              <span
                                title={`Overstocked: ${(item.excess_units || 0).toLocaleString()} units above the order-up-to target${item.excess_value_gbp ? ` (~${fmtGBP(item.excess_value_gbp)} tied up)` : ''}. Defer replenishment or rebalance.`}
                                style={{ fontSize: 11, fontWeight: 800, padding: '2px 6px', borderRadius: 10, background: 'var(--status-ai-bg)', color: 'var(--status-ai-text)', border: '1px solid var(--status-ai-border)', cursor: 'default' }}
                              >
                                EXCESS
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          {needsAction && can('write:po') && (
                            isHubScope ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); setTransferReq({ sku: item.sku_code, toCode: scope, qty: item.target_order_qty || undefined }) }}
                                style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 6, background: 'var(--status-ai-bg)', color: 'var(--status-ai-text)', border: '1px solid var(--status-ai-border)', whiteSpace: 'nowrap', cursor: 'pointer' }}
                              >
                                ⇄ Transfer
                              </button>
                            ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRaisePO(item.sku_code) }}
                                style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 6, background: 'var(--status-danger-bg)', color: 'var(--status-danger-text)', border: '1px solid var(--status-danger-border)', whiteSpace: 'nowrap', cursor: 'pointer' }}
                              >
                                + Raise PO
                              </button>
                            )
                          )}
                        </td>
                      </tr>

                      {/* SKU drill-in: site split (network scope) + projection / forecast tabs */}
                      {isSelected && (
                        <tr style={{ background: c.info.bg }}>
                          <td colSpan={scope === 'NETWORK' ? 14 : 13} style={{ padding: '14px 20px' }}>
                            {scope === 'NETWORK' && (
                              <SiteBreakdown item={skuDetail} onTransfer={
                                can('write:po')
                                  ? (site: any) => setTransferReq({ sku: item.sku_code, toCode: site.warehouse_code, qty: site.replenishment_qty || undefined })
                                  : undefined
                              } />
                            )}

                            {/* Drill-in tabs */}
                            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                              {([
                                { id: 'projection', label: 'Stock Projection & What-If', icon: TrendingUp },
                                { id: 'forecast', label: 'Forecast & Quality', icon: Activity },
                              ] as const).map(t => (
                                <button
                                  key={t.id}
                                  onClick={(e) => { e.stopPropagation(); setDrillTab(t.id) }}
                                  style={{
                                    fontSize: 11, fontWeight: 700, padding: '5px 12px', borderRadius: 7, cursor: 'pointer',
                                    display: 'inline-flex', alignItems: 'center', gap: 5,
                                    background: drillTab === t.id ? '#2563EB' : c.surface,
                                    color: drillTab === t.id ? '#fff' : c.textSecondary,
                                    border: `1px solid ${drillTab === t.id ? '#2563EB' : c.border}`,
                                  }}
                                >
                                  <t.icon size={12} /> {t.label}
                                </button>
                              ))}
                            </div>

                            {drillTab === 'projection' ? (
                              <ProjectionPanel item={item} inbounds={inboundsForSku(item.sku_code)} scope={scope} />
                            ) : (
                              <>
                                {skuForecast
                                  ? <><DemandChart sku={item} forecast={skuForecast} /><ForecastWaterfall forecast={skuForecast} /></>
                                  : <div style={{ fontSize: 12, color: c.textSecondary, padding: '8px 0' }}>Loading demand history &amp; forecast…</div>
                                }
                                <SafetyStockExplainer item={item} />
                                {skuDetail && <QualityPanel item={skuDetail} />}
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
                {items.length === 0 && (
                  <tr><td colSpan={scope === 'NETWORK' ? 14 : 13} style={{ textAlign: 'center', fontSize: 12, color: c.textMuted, padding: '26px 0' }}>
                    No SKUs match these filters.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination — the table only ever holds one page of rows */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 16px', borderTop: `1px solid ${c.borderSubtle}`, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: c.textSecondary }}>
              {totalRows === 0 ? 'No results' : `Showing ${((page - 1) * PER_PAGE + 1).toLocaleString()}–${Math.min(page * PER_PAGE, totalRows).toLocaleString()} of ${totalRows.toLocaleString()}`}
              {invFetching && <span style={{ color: c.textMuted }}> · updating…</span>}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {[
                { label: '‹‹ First', to: 1, disabled: page <= 1 },
                { label: '‹ Prev', to: page - 1, disabled: page <= 1 },
              ].map(b => (
                <button key={b.label} disabled={b.disabled} onClick={() => setPage(b.to)}
                  style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6, cursor: b.disabled ? 'default' : 'pointer', opacity: b.disabled ? 0.4 : 1, background: c.surface, color: c.textSecondary, border: `1px solid ${c.border}` }}>
                  {b.label}
                </button>
              ))}
              <span style={{ fontSize: 11, fontWeight: 700, color: c.textPrimary, padding: '0 6px' }}>
                Page {page.toLocaleString()} / {totalPages.toLocaleString()}
              </span>
              {[
                { label: 'Next ›', to: page + 1, disabled: page >= totalPages },
                { label: 'Last ››', to: totalPages, disabled: page >= totalPages },
              ].map(b => (
                <button key={b.label} disabled={b.disabled} onClick={() => setPage(b.to)}
                  style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6, cursor: b.disabled ? 'default' : 'pointer', opacity: b.disabled ? 0.4 : 1, background: c.surface, color: c.textSecondary, border: `1px solid ${c.border}` }}>
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        </>
        )}

        {/* ═══════════ EXECUTE ═══════════ */}
        {subTab === 'execute' && (
        <>
        <PlaneHeader
          plane="EXECUTE"
          tip="Cost to Serve"
          title="Replenishment & fulfilment"
          subtitle="Cost-aware DRP recommendations · supplier POs & trunker transfers · goods receipt closes the loop"
          icon={Truck}
        />

        {/* ── How a shortfall is filled at each echelon (PO vs STO) ──────────── */}
        <div data-tour="dem-routing">
          <ReplenishmentRoutingCard />
        </div>

        {/* ── Replenishment queues: supplier POs → NDC · transfers NDC → hubs ── */}
        <div className="auto-grid section-gap" style={{ '--cols': isHubScope ? '1' : '2', '--col-min': '300px', '--grid-gap': '12px' } as React.CSSProperties}>

          {/* Supplier PO Queue — suppliers only ever deliver into the Leicester
              NDC, so this queue is meaningless once a hub is scoped; show it only
              at Whole Network or the NDC itself. */}
          {!isHubScope && (
          <div className="card" data-tour="dem-po">
            <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 190 }}>
                <div className="card-title" id="po-queue">Purchase Orders — supplier → Leicester NDC</div>
                <div className="card-subtitle">
                  {orders?.total || 0} purchase order{(orders?.total || 0) !== 1 ? 's' : ''}
                  {supplierFilter
                    ? <> from <b>{supplierName(supplierFilter)}</b> · <button
                        onClick={() => setSupplierFilter(null)}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: c.info.text, fontSize: 'inherit', textDecoration: 'underline' }}
                      >show all suppliers</button></>
                    : ' · suppliers deliver to the NDC only'}
                </div>
              </div>

              {/* Supplier filter — also the control the Risk module drives when it
                  deep-links here with ?supplier=… */}
              <MiniSelect value={poStatus} onChange={setPoStatus} active={poStatus !== 'all'} title="Filter by PO status"
                options={[{ value: 'all', label: 'All statuses' }, ...((orders?.statuses ?? []).map((x: string) => ({ value: x, label: x.replace(/_/g, ' ') })))]} />
              <select
                value={supplierFilter ?? 'all'}
                onChange={e => setSupplierFilter(e.target.value === 'all' ? null : e.target.value)}
                aria-label="Filter purchase orders by supplier"
                title="Filter the purchase order queue to one supplier"
                style={{
                  fontSize: 12, padding: '5px 9px', borderRadius: 6, cursor: 'pointer',
                  border: `1px solid ${supplierFilter ? '#2563EB' : c.border}`,
                  background: c.surface,
                  color: supplierFilter ? '#2563EB' : c.textPrimary,
                  fontWeight: supplierFilter ? 700 : 400, maxWidth: 190,
                }}
              >
                <option value="all">All suppliers</option>
                {supplierOptions.map((sp: any) => (
                  <option key={sp.code} value={sp.code}>
                    {sp.name}{sp.po_count ? ` · ${sp.po_count}` : ''}
                  </option>
                ))}
              </select>
              {autoPO?.enabled && (
                <div
                  title={`Powered by ATLAS's own governed autonomy cycle — the same one behind the approvals queue. ${autoPO.trigger} Open auto POs: ${autoPO.auto_pos_open?.length ?? 0}. The system never double-orders — SKUs with a PO already in flight are skipped.`}
                  style={{
                    fontSize: 11, fontWeight: 700, color: 'var(--status-ai-text)', background: 'var(--status-ai-bg)',
                    border: '1px solid var(--status-ai-border)', borderRadius: 7, padding: '5px 10px',
                    display: 'flex', alignItems: 'center', gap: 5, cursor: 'default', flexWrap: 'wrap',
                  }}
                >
                  🤖 Auto PO active
                  {/* What ATLAS has actually done today, folded into this chip rather
                      than a separate "actioned today" widget — one badge for what it
                      is, one for what it's waiting on you for. */}
                  {(autoPO.actions_today ?? 0) > 0 && (
                    <span style={{ background: '#6D28D9', color: '#fff', borderRadius: 10, padding: '1px 7px', fontSize: 11 }}>
                      {autoPO.actions_today} actioned today
                    </span>
                  )}
                  {(autoPO.pending_emergency_approval ?? 0) > 0 && (
                    <span
                      title="Emergency POs always wait for your approval — they carry an unplanned freight premium, so ATLAS never raises one on its own."
                      style={{ background: 'var(--status-danger-bg)', color: 'var(--status-danger-text)', border: '1px solid var(--status-danger-border)', borderRadius: 10, padding: '1px 7px', fontSize: 11 }}
                    >
                      {autoPO.pending_emergency_approval} critical SKU{autoPO.pending_emergency_approval > 1 ? 's' : ''} awaiting your approval
                    </span>
                  )}
                </div>
              )}
              {lastCreatedPO && (
                <div style={{ fontSize: 11, fontWeight: 700, color: c.success.text, background: c.success.bg, border: `1px solid ${c.success.border}`, borderRadius: 7, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Check size={14} /> {lastCreatedPO} raised</span>
                </div>
              )}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>PO #</th>
                    <th>SKU / Supplier</th>
                    <th><ColTooltip label="Type" lookupKey="PO Type" /></th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}><ColTooltip label="Value (£)" /></th>
                    <th style={{ textAlign: 'right' }}><ColTooltip label="Delivery" /></th>
                  </tr>
                </thead>
                <tbody>
                  {(orders?.items || []).map((po: any) => {
                    const deliveryMs = po.expected_delivery ? new Date(po.expected_delivery).getTime() : null
                    const daysToDelivery = deliveryMs ? Math.round((deliveryMs - Date.now()) / 86400000) : null
                    const pill = po.status === 'in_transit'
                      ? { bg: c.success.bg, color: c.success.text, border: c.success.border }
                      : po.status === 'confirmed'
                        ? { bg: c.info.bg, color: c.info.text, border: c.info.border }
                        : { bg: c.chipBg, color: c.chipText, border: c.chipBorder }
                    const isEmergency = po.po_type === 'emergency'
                    const isNew = po.po_number === lastCreatedPO
                    return (
                      <tr key={po.po_number} style={{
                        borderLeft: isEmergency ? '3px solid #EF4444' : isNew ? '3px solid #10B981' : undefined,
                        background: isNew ? c.success.bg : undefined,
                      }}>
                        <td style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700 }}>
                          {po.po_number}
                          {isNew && <span style={{ fontSize: 11, fontWeight: 800, marginLeft: 5, padding: '1px 5px', borderRadius: 10, background: '#10B981', color: '#fff' }}>NEW</span>}
                          {po.is_auto_generated && (
                            <span
                              title={po.auto_reason ? `Auto-raised: ${po.auto_reason}` : 'Auto-raised by the replenishment engine'}
                              style={{ fontSize: 11, fontWeight: 800, marginLeft: 5, padding: '1px 5px', borderRadius: 10, background: '#8B5CF6', color: '#fff', cursor: 'default' }}
                            >
                              AUTO
                            </span>
                          )}
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {po.supplier_name || po.supplier_code}
                          {po.sku_code && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'monospace' }}>{po.sku_code}</div>}
                        </td>
                        <td style={{ fontSize: 11, fontWeight: 700 }}>{PO_TYPE_LABEL[po.po_type] || po.po_type}</td>
                        <td>
                          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: pill.bg, color: pill.color, border: `1px solid ${pill.border}` }}>
                            {po.status.replace('_', ' ')}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 12, fontWeight: 600 }}>
                          {po.total_value_gbp?.toLocaleString('en-GB', { maximumFractionDigits: 0 })}
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 11, fontWeight: daysToDelivery !== null && daysToDelivery <= 2 ? 700 : 400, color: daysToDelivery === null ? '#9CA3AF' : daysToDelivery <= 2 ? '#EF4444' : daysToDelivery <= 5 ? '#F59E0B' : '#6B7280' }}>
                          {po.status === 'received' ? (
                            <span title={`Booked in · ${po.goods_receipt_note || 'GRN'} · 3-way match`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--status-success-text)', fontWeight: 700 }}>
                              <PackageCheck size={12} /> received
                            </span>
                          ) : po.status === 'in_transit' && can('write:po') ? (
                            <button
                              onClick={() => receivePOMutation.mutate(po.po_number)}
                              disabled={receivePOMutation.isPending}
                              title="Book goods in at the NDC (goods receipt + 3-way match)"
                              style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, cursor: 'pointer', background: c.success.bg, color: c.success.text, border: `1px solid ${c.success.border}`, whiteSpace: 'nowrap' }}
                            >
                              Receive
                            </button>
                          ) : (daysToDelivery === null ? '—' : daysToDelivery <= 0 ? 'Today' : `${daysToDelivery}d`)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <TablePager page={orders?.page ?? 1} pages={orders?.pages ?? 1} total={orders?.total ?? 0}
              perPage={QUEUE_PER} onPage={setPoPage} label="purchase orders" busy={poFetching} />
          </div>
          )}

          {/* Stock Transfer Queue */}
          <div className="card" data-tour="dem-sto">
            <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 190 }}>
                <div className="card-title"><HelpTip tip="Stock Transport Order">Stock Transport Orders — raised by hubs</HelpTip></div>
                <ActionedToday module="/demand" section="Stock Transfers" label="transfer"
                  emptyHint="No stock transfers raised today." />
                <div className="card-subtitle">
                  {transfers?.total ?? 0} STO{(transfers?.total ?? 0) !== 1 ? 's' : ''}
                  {stoStatus === 'all' ? ' · all-time' : ''}
                  {isHubScope ? ` raised by ${refData.siteName[scope]}` : ' · the receiving hub raises the order on the NDC (doc type UB)'}
                </div>
              </div>
              {/* Defaults to "all" (every STO ever raised, including delivered/
                  cancelled) — that total won't match the Network Flow card above,
                  which only counts currently-open STOs. Filter to an open status
                  to compare like for like. */}
              <MiniSelect value={stoStatus} onChange={setStoStatus} active={stoStatus !== 'all'} title="Filter by STO status"
                options={[{ value: 'all', label: 'All statuses' }, ...((transfers?.statuses ?? []).map((x: string) => ({ value: x, label: x.replace(/_/g, ' ') })))]} />
              {lastCreatedTransfer && (
                <div style={{ fontSize: 11, fontWeight: 700, color: c.success.text, background: c.success.bg, border: `1px solid ${c.success.border}`, borderRadius: 7, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Check size={14} /> {lastCreatedTransfer} created</span>
                </div>
              )}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Transfer #</th>
                    <th>SKU</th>
                    <th>Raised by → supplied from</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}><ColTooltip label="ETA" lookupKey="Transfer ETA" /></th>
                  </tr>
                </thead>
                <tbody>
                  {scopeTransfers.map((t: any) => {
                    const etaMs = t.expected_arrival ? new Date(t.expected_arrival).getTime() : null
                    const hoursToEta = etaMs ? Math.round((etaMs - Date.now()) / 3600000) : null
                    const pill = t.status === 'in_transit'
                      ? { bg: c.success.bg, color: c.success.text, border: c.success.border }
                      : { bg: c.info.bg, color: c.info.text, border: c.info.border }
                    const isNew = t.transfer_id === lastCreatedTransfer
                    return (
                      <tr key={t.transfer_id} style={{
                        borderLeft: isNew ? '3px solid #10B981' : undefined,
                        background: isNew ? c.success.bg : undefined,
                      }}>
                        <td style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700 }}>
                          {t.transfer_id}
                          {isNew && <span style={{ fontSize: 11, fontWeight: 800, marginLeft: 5, padding: '1px 5px', borderRadius: 10, background: '#10B981', color: '#fff' }}>NEW</span>}
                          {t.is_auto_generated && (
                            <span
                              title={t.reason ? `Auto-raised: ${t.reason}` : 'Auto-raised by the DRP engine'}
                              style={{ fontSize: 11, fontWeight: 800, marginLeft: 5, padding: '1px 5px', borderRadius: 10, background: '#8B5CF6', color: '#fff', cursor: 'default' }}
                            >
                              AUTO
                            </span>
                          )}
                        </td>
                        <td style={{ fontSize: 12 }}>
                          <div style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700 }}>{t.sku_code}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</div>
                        </td>
                        <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                          <div style={{ fontWeight: 700 }}>
                            {refData.siteShort[t.raised_by || t.to_warehouse] || t.raised_by || t.to_warehouse}
                            <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}> raised on </span>
                            {refData.siteShort[t.supplying_site || t.from_warehouse] || t.supplying_site || t.from_warehouse}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 3 }}>
                            goods {refData.siteShort[t.from_warehouse] || t.from_warehouse}
                            <ArrowRight size={8} />
                            {refData.siteShort[t.to_warehouse] || t.to_warehouse}
                            {t.is_lateral && <span style={{ color: 'var(--status-warning-text)', fontWeight: 700 }}>· lateral</span>}
                            {t.doc_type && <span style={{ fontFamily: 'monospace' }}>· {t.doc_type}</span>}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 12, fontWeight: 600 }}>{t.quantity?.toLocaleString()}</td>
                        <td>
                          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: pill.bg, color: pill.color, border: `1px solid ${pill.border}` }}>
                            {TRANSFER_STATUS_LABEL[t.status] || t.status}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 11, fontWeight: hoursToEta !== null && hoursToEta <= 6 ? 700 : 400, color: hoursToEta === null ? '#9CA3AF' : '#6B7280' }}>
                          {t.status === 'in_transit' && can('write:po') ? (
                            <button
                              onClick={() => receiveTransferMutation.mutate(t.transfer_id)}
                              disabled={receiveTransferMutation.isPending}
                              title="Confirm delivered into the hub"
                              style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, cursor: 'pointer', background: c.success.bg, color: c.success.text, border: `1px solid ${c.success.border}`, whiteSpace: 'nowrap' }}
                            >
                              Receive
                            </button>
                          ) : (hoursToEta === null ? '—' : hoursToEta <= 0 ? 'Due' : hoursToEta < 24 ? `${hoursToEta}h` : `${Math.round(hoursToEta / 24)}d`)}
                        </td>
                      </tr>
                    )
                  })}
                  {scopeTransfers.length === 0 && (
                    <tr><td colSpan={6} style={{ textAlign: 'center', fontSize: 11, color: c.textMuted, padding: '18px 0' }}>No open transfers — hub positions are inside their cover windows</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <TablePager page={transfers?.page ?? 1} pages={transfers?.pages ?? 1} total={transfers?.total ?? 0}
              perPage={QUEUE_PER} onPage={setStoPage} label="STOs" busy={stoFetching} />
          </div>
        </div>
        </>
        )}

        {/* ═══════════ ORCHESTRATE ═══════════ */}
        {/* Network-wide programmes only make sense at network scope — scoping to
            one hub doesn't change S&OP allocation, the digital twin, or the grant
            / service-book / rollout pipelines, so hide the whole plane rather than
            show data that doesn't actually respond to the site filter. */}
        {subTab === 'orchestrate' && scope === 'NETWORK' && (
          <>
            <PlaneHeader
              plane="ORCHESTRATE"
              tip="S&OP"
              title="S&OP, allocation & the network twin"
              subtitle="Medium-term demand vs supply · constrained allocation for long-lead kit · digital-twin what-if at network scale"
              icon={CalendarRange}
            />

            <div className="auto-grid section-gap" style={{ '--cols': '2', '--col-min': '300px', '--grid-gap': '12px' } as React.CSSProperties}>
              <div data-tour="dem-sop" style={{ display: 'grid', minWidth: 0 }}>
                <SopAllocationCard />
              </div>
              <div data-tour="dem-twin" style={{ display: 'grid', minWidth: 0 }}>
                <ScenarioTwinCard />
              </div>
            </div>
          </>
        )}

        {/* ═══════════ PROGRAMMES ═══════════ */}
        {/* Same network-wide reasoning as Orchestrate — grants, the service book
            and rollout volume don't change when a hub is scoped. */}
        {subTab === 'programmes' && scope === 'NETWORK' && (
          <>
            <PlaneHeader
              plane="ORCHESTRATE"
              tip="Programme Pipelines"
              title="Programme & Policy Drivers"
              subtitle="Grants, the service book and the rollout programme — medium-term volume drivers that feed S&OP, plus OEM/MHHS pipeline health"
              icon={TrendingUp}
            />

            {/* Medium-term volume drivers: grants, service book, rollout programme */}
            <div data-tour="dem-programmes">
              <ProgrammePolicyDrivers signals={signals} />
            </div>

            {/* ── Programme Pipelines ─────────────────────────────────────────── */}
            <div className="card">
              <div className="card-header">
                <div className="card-title">Programme Pipelines</div>
              </div>
              <div className="auto-grid card-body" style={{ '--cols': '2', '--col-min': '280px', '--grid-gap': '16px' } as React.CSSProperties}>

                {/* Heat Pump Pipeline */}
                {hpPipeline && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: c.warning.text, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Thermometer size={12} /> Heat Pump Programme
                    </div>
                    <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px', marginBottom: 12 } as React.CSSProperties}>
                      <ProgStat label="Installs YTD"
                        value={(hpPipeline.installs_ytd || 0).toLocaleString()}
                        sub={`of ${(hpPipeline.installs_target_fy || 0).toLocaleString()} FY target`}
                      />
                      <ProgStat label="Certified Engineers"
                        value={(hpPipeline.engineers_heat_pump_certified || 0).toLocaleString()}
                        sub="HP-qualified"
                      />
                    </div>
                    {/* YTD progress */}
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ height: 6, background: 'var(--status-warning-bg)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{
                          width: `${Math.min(100, ((hpPipeline.installs_ytd || 0) / (hpPipeline.installs_target_fy || 1)) * 100)}%`,
                          height: '100%', background: '#F59E0B', borderRadius: 4,
                        }} />
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3 }}>
                        {(((hpPipeline.installs_ytd || 0) / (hpPipeline.installs_target_fy || 1)) * 100).toFixed(1)}% of FY target
                      </div>
                    </div>
                    <table className="data-table" style={{ fontSize: 11 }}>
                      <thead>
                        <tr>
                          <th>OEM</th>
                          <th style={{ textAlign: 'right' }}><ColTooltip label="Lead Time" /></th>
                          <th style={{ textAlign: 'right' }}><ColTooltip label="Open POs" /></th>
                          <th style={{ textAlign: 'right' }}><ColTooltip label="OTIF %" /></th>
                          <th><ColTooltip label="Next HGV" /></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(hpPipeline.oems || []).map((oem: any) => (
                          <tr key={oem.name}>
                            <td style={{ fontWeight: 600 }}>{oem.name}</td>
                            <td style={{ textAlign: 'right', fontWeight: 600, color: oem.lead_time_weeks >= 18 ? '#EF4444' : '#F59E0B' }}>
                              {oem.lead_time_weeks}w
                            </td>
                            <td style={{ textAlign: 'right' }}>{oem.open_pos}</td>
                            <td style={{ textAlign: 'right', fontWeight: 700, color: oem.otif >= 88 ? '#059669' : oem.otif >= 75 ? '#D97706' : '#EF4444' }}>
                              {oem.otif}%
                            </td>
                            <td style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{oem.next_hgv_slot}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Smart Meter Programme */}
                {smDash && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: c.success.text, marginBottom: 10 }}>
                      📟 Smart Meter Programme (MHHS)
                    </div>
                    <div className="auto-grid" style={{ '--cols': '2', '--col-min': '150px', '--grid-gap': '8px', marginBottom: 10 } as React.CSSProperties}>
                      <ProgStat label="Installed YTD"
                        value={(smDash.mhhs_progress?.installed_ytd || 0).toLocaleString()}
                        sub={`of ${(smDash.mhhs_progress?.target || 48000).toLocaleString()}`}
                      />
                      <ProgStat label="DCC Registration"
                        value={`${smDash.dcc_registration_rate?.toFixed(1)}%`}
                        sub="registered with DCC"
                      />
                    </div>
                    <div className="auto-grid" style={{ '--cols': '4', '--col-min': '96px', '--grid-gap': '6px' } as React.CSSProperties}>
                      {[
                        { label: 'BG Kits', value: smDash.kits_in_stock?.british_gas },
                        { label: 'PHJ Kits', value: smDash.kits_in_stock?.ph_jones },
                        { label: 'BG Eng.', value: smDash.smet2_certified_engineers?.british_gas },
                        { label: 'PHJ Eng.', value: smDash.smet2_certified_engineers?.ph_jones },
                      ].map(({ label, value }) => (
                        <div key={label} style={{ textAlign: 'center', background: c.success.bg, borderRadius: 7, padding: '8px 4px', border: `1px solid ${c.success.border}` }}>
                          <div style={{ fontSize: 15, fontWeight: 800, color: c.success.text }}>{(value || 0).toLocaleString()}</div>
                          <div style={{ fontSize: 11, color: c.textSecondary, marginTop: 2 }}>{label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            </div>
          </>
        )}

      </div>

      {/* Raise PO Modal — full position fetched on demand for the chosen SKU */}
      {raisePOSku && modalItem && modalItem.sku_code === raisePOSku && (
        <RaisePOModal
          item={modalItem}
          onClose={handleCloseModal}
          onSubmit={(payload) => createPOMutation.mutate(payload)}
          submitting={createPOMutation.isPending}
          error={createPOMutation.isError}
        />
      )}

      {/* Stock Transfer Modal */}
      {transferReq && modalItem && modalItem.sku_code === transferReq.sku && (
        <TransferModal
          item={modalItem}
          initialToCode={transferReq.toCode}
          fromCode={transferReq.fromCode}
          initialQty={transferReq.qty}
          onClose={handleCloseTransfer}
          onSubmit={(payload) => createTransferMutation.mutate(payload)}
          submitting={createTransferMutation.isPending}
          error={createTransferMutation.isError}
        />
      )}
    </>
  )
}

// ─── Network flow card ───────────────────────────────────────────────────────

function NetworkFlowCard({ network, scope, onSelectSite }: {
  network: any
  scope: string
  onSelectSite: (code: string) => void
}) {
  const { c } = useTheme()
  const refData = useReferenceData()
  const ndc = network.ndc || {}
  const hubs = network.hubs || []
  const sup = network.suppliers || {}
  const flows = network.flows || {}
  const routes = network.routes || []

  const nodeRag = (site: any) =>
    site.stockouts > 0 ? '#EF4444' : site.skus_at_risk > 0 ? '#F59E0B' : '#10B981'
  const siteLabel = (code: string) => refData.siteShort[code] || refData.siteName[code] || code

  return (
    <div className="card section-gap">
      <div className="card-header">
        <div>
          <div className="card-title">Network Flow — Suppliers → NDC → Regional Hubs</div>
          <div className="card-subtitle">
            Parts land at the Leicester NDC from suppliers, then move to hubs by trunker transfer · click a site to scope the page
          </div>
        </div>
      </div>
      <div className="card-body flow-row">

        {/* Suppliers node */}
        <div style={{ borderRadius: 10, border: `1px solid ${c.border}`, background: c.surfaceSubtle, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: c.textSecondary, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Factory size={12} /> Suppliers
          </div>
          <div style={{ fontSize: 24, fontWeight: 900, color: c.textPrimary, lineHeight: 1 }}>{sup.count ?? '—'}</div>
          <div style={{ fontSize: 11, color: c.textMuted, marginTop: 3 }}>OEMs & merchants</div>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: c.textSecondary }}>Avg OTIF</span>
              <span style={{ fontWeight: 700, color: (sup.avg_otif ?? 100) >= 90 ? '#059669' : '#D97706' }}>{sup.avg_otif != null ? `${sup.avg_otif}%` : '—'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: c.textSecondary }}>Open PO value</span>
              <span style={{ fontWeight: 700, color: c.textPrimary }}>£{((sup.open_po_value_gbp || 0) / 1000).toFixed(0)}k</span>
            </div>
          </div>
        </div>

        {/* Leg: suppliers → NDC */}
        <FlowLeg
          top={`${flows.supplier_to_ndc?.open_pos ?? 0} POs`}
          bottom={flows.supplier_to_ndc?.emergency_pos ? `${flows.supplier_to_ndc.emergency_pos} emg` : undefined}
          bottomColor="#EF4444"
        />

        {/* NDC node */}
        <SiteNode
          site={ndc}
          active={scope === 'LEI_COE'}
          accent={nodeRag(ndc)}
          icon={<Warehouse size={12} />}
          roleLabel="National Distribution Centre"
          onClick={() => onSelectSite('LEI_COE')}
        />

        {/* Leg: NDC/sister hubs → each hub, one arrow per hub instead of a single
            blended figure — so the exact supplying site and STO count for THAT
            hub is right there against it. A lateral hub → hub rebalance (the NDC
            couldn't cover it, a sister hub could) shows an amber arrow labelled
            with its actual source instead of the NDC. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {hubs.map((hub: any) => {
            const hubRoutes = routes.filter((r: any) => r.to_code === hub.warehouse_code)
            return (
              <div key={hub.warehouse_code} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, padding: '0 2px', minWidth: 0, minHeight: 54, boxSizing: 'border-box' }}>
                {hubRoutes.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, opacity: 0.45 }} title="No open STOs on this leg right now">
                    <ArrowRight size={14} color={c.textMuted} />
                    <span style={{ fontSize: 11, fontWeight: 800, color: c.textMuted, whiteSpace: 'nowrap' }}>0 STOs</span>
                  </div>
                ) : hubRoutes.map((r: any) => (
                  <div key={`${r.from_code}-${r.to_code}`}
                    title={`${r.count} open STO${r.count !== 1 ? 's' : ''} · ${r.units.toLocaleString()} units · ${r.lateral ? `lateral rebalance from ${siteLabel(r.from_code)}` : 'NDC trunker transfer'}`}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}
                  >
                    {r.lateral && (
                      <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--status-warning-text)', whiteSpace: 'nowrap' }}>{siteLabel(r.from_code)}</span>
                    )}
                    <ArrowRight size={14} color={r.lateral ? '#D97706' : c.textMuted} />
                    <span style={{ fontSize: 11, fontWeight: 800, color: r.lateral ? '#D97706' : c.textSecondary, whiteSpace: 'nowrap' }}>
                      {r.count} STO{r.count !== 1 ? 's' : ''}
                    </span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>

        {/* Hubs stack */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {hubs.map((hub: any) => (
            <SiteNode
              key={hub.warehouse_code}
              site={hub}
              compact
              active={scope === hub.warehouse_code}
              accent={nodeRag(hub)}
              icon={<Truck size={11} />}
              roleLabel={`${hub.transfer_lead_days ?? 1}d trunker lead`}
              onClick={() => onSelectSite(hub.warehouse_code)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function FlowLeg({ top, bottom, bottomColor }: { top: string; bottom?: string; bottomColor?: string }) {
  const { c } = useTheme()
  return (
    <div className="flow-leg" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '0 4px' }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, whiteSpace: 'nowrap' }}>{top}</span>
      <ArrowRight size={18} color={c.textMuted} />
      {bottom && <span style={{ fontSize: 11, fontWeight: 700, color: bottomColor || c.textMuted, whiteSpace: 'nowrap' }}>{bottom}</span>}
    </div>
  )
}

function SiteNode({ site, accent, icon, roleLabel, onClick, active, compact }: {
  site: any; accent: string; icon: React.ReactNode; roleLabel: string
  onClick: () => void; active?: boolean; compact?: boolean
}) {
  const { c } = useTheme()
  return (
    <div
      onClick={onClick}
      style={{
        borderRadius: 10, cursor: 'pointer', boxSizing: 'border-box',
        border: `1.5px solid ${active ? '#2563EB' : c.border}`,
        borderLeft: `4px solid ${accent}`,
        background: active ? c.info.bg : c.surface,
        padding: compact ? '8px 12px' : '14px 16px',
        minHeight: compact ? 54 : undefined,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: compact ? 11 : 12, fontWeight: 800, color: c.textPrimary, display: 'flex', alignItems: 'center', gap: 5 }}>
          {icon} {site.warehouse_name || '—'}
          {site.is_disrupted && <span style={{ fontSize: 11, fontWeight: 800, padding: '1px 5px', borderRadius: 8, background: 'var(--status-danger-bg)', color: 'var(--status-danger-text)' }}>DISRUPTED</span>}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span style={{ fontSize: compact ? 13 : 18, fontWeight: 900, color: c.textPrimary }}>{(site.units_on_hand ?? 0).toLocaleString()}</span>
          <span style={{ fontSize: 11, color: c.textMuted }}>units</span>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: compact ? 3 : 6 }}>
        <span style={{ fontSize: 11, color: c.textMuted }}>{roleLabel}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: site.skus_at_risk > 0 ? '#D97706' : '#059669' }}>
          {site.stockouts > 0
            ? `${site.stockouts} stockout${site.stockouts > 1 ? 's' : ''}`
            : site.skus_at_risk > 0
              ? `${site.skus_at_risk} SKU${site.skus_at_risk > 1 ? 's' : ''} at risk`
              : 'healthy'} · {site.avg_days_of_supply ?? 0}d cover
        </span>
      </div>
    </div>
  )
}

// ─── Site health dots & breakdown ────────────────────────────────────────────

// Compact per-site health from the lightweight `site_rag` map, so list rows never
// have to carry the full nested per-site breakdown.
function SiteDots({ siteRag }: { siteRag?: Record<string, string> }) {
  const refData = useReferenceData()
  if (!siteRag) return <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
      {Object.entries(siteRag).map(([code, rag]) => (
        <span
          key={code}
          title={`${refData.siteName[code] || code}: ${RAG_LABEL[rag] || rag}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'default' }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: RAG_COLOR[rag] || '#9CA3AF', display: 'inline-block' }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)' }}>{refData.siteShort[code]}</span>
        </span>
      ))}
    </div>
  )
}

function SiteBreakdown({ item, onTransfer }: { item: any; onTransfer?: (site: any) => void }) {
  const { c } = useTheme()
  if (!item?.by_warehouse?.length) return null
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--status-info-text)', marginBottom: 8 }}>
        Stock by Site — {item.sku_code}
      </div>
      <table className="data-table" style={{ fontSize: 11 }}>
        <thead>
          <tr>
            <th>Site</th>
            <th>Replenished From</th>
            <th style={{ textAlign: 'right' }}>Demand Share</th>
            <th style={{ textAlign: 'right' }}>On Hand</th>
            <th style={{ textAlign: 'right' }}>Available</th>
            <th style={{ textAlign: 'right' }}>Safety</th>
            <th style={{ textAlign: 'right' }}>Days Cover</th>
            <th style={{ textAlign: 'right' }}>Replen Lead</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {item.by_warehouse.map((s: any) => (
            <tr key={s.warehouse_code} style={{ borderLeft: `3px solid ${RAG_COLOR[s.rag_status] || '#E5E7EB'}` }}>
              <td style={{ fontWeight: 700 }}>
                {s.warehouse_name}
                {s.role === 'ndc' && <span style={{ fontSize: 11, fontWeight: 800, marginLeft: 5, padding: '1px 5px', borderRadius: 8, background: c.chipBg, color: c.chipText }}>NDC</span>}
              </td>
              <td style={{ fontSize: 11, color: c.textSecondary }}>{s.replenished_from}</td>
              <td style={{ textAlign: 'right', color: c.textSecondary }}>{s.demand_share_pct}%</td>
              <td style={{ textAlign: 'right', fontWeight: 600 }}>{s.quantity_on_hand.toLocaleString()}</td>
              <td style={{ textAlign: 'right', fontWeight: 700, color: s.quantity_available === 0 ? '#EF4444' : 'inherit' }}>{s.quantity_available.toLocaleString()}</td>
              <td style={{ textAlign: 'right', color: c.textSecondary }}>{s.safety_stock_level.toLocaleString()}</td>
              <td style={{ textAlign: 'right', fontWeight: 600 }}>{s.days_of_supply > 900 ? '—' : `${s.days_of_supply}d`}</td>
              <td style={{ textAlign: 'right', color: c.textSecondary }}>{s.replenishment_lead_days}d</td>
              <td>
                <span style={{
                  fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 20,
                  background: c.ragBg[s.rag_status as 'G' | 'A' | 'R'] || c.surfaceSubtle,
                  color: RAG_COLOR[s.rag_status] || c.textSecondary,
                  border: `1px solid ${RAG_COLOR[s.rag_status] || c.border}55`,
                }}>
                  {RAG_LABEL[s.rag_status] || s.rag_status}
                </span>
              </td>
              <td>
                {s.role === 'hub' && s.rag_status !== 'G' && onTransfer && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onTransfer(s) }}
                    style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: 'var(--status-ai-bg)', color: 'var(--status-ai-text)', border: '1px solid var(--status-ai-border)', whiteSpace: 'nowrap', cursor: 'pointer' }}
                  >
                    ⇄ Transfer
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── ABC/XYZ segmentation ────────────────────────────────────────────────────

function SegmentBadge({ item }: { item: any }) {
  if (!item.segment) return <span>—</span>
  const color = ABC_COLOR[item.abc_class] || '#6B7280'
  return (
    <span
      title={`${item.abc_class} = ${item.abc_class === 'A' ? 'high' : item.abc_class === 'B' ? 'medium' : 'low'} annual value (${fmtGBP(item.annual_value_gbp || 0)}/yr) · ${item.xyz_class} = ${item.xyz_class === 'X' ? 'stable' : item.xyz_class === 'Y' ? 'variable' : 'volatile'} demand (CV ${item.demand_cv}) · service target ${item.service_level_target_pct}%`}
      style={{
        fontSize: 11, fontWeight: 800, padding: '2px 7px', borderRadius: 6, cursor: 'default',
        background: `${color}14`, color, border: `1px solid ${color}45`, fontFamily: 'monospace',
      }}
    >
      {item.segment}
    </span>
  )
}

function SegmentationCard({ summary, activeSegment, onSelect }: {
  summary: any
  activeSegment: string
  onSelect: (segment: string) => void
}) {
  const { c } = useTheme()
  const [hoverSeg, setHoverSeg] = useState<string | null>(null)
  const XYZ_DESC: Record<string, string> = { X: 'stable', Y: 'variable', Z: 'volatile' }
  // Matrix comes pre-aggregated from the server — one lookup per cell, no scan
  const bySeg = useMemo(() => {
    const m: Record<string, any> = {}
    for (const s of summary?.segments ?? []) m[s.segment] = s
    return m
  }, [summary])
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <LayoutGrid size={15} color="#2563EB" /> ABC / XYZ Segmentation
          </div>
          <div className="card-subtitle">Value (A–C) × demand predictability (X–Z) · click a cell to filter the whole page</div>
        </div>
      </div>
      <div className="card-body">
        <div className="matrix-grid" style={{ '--matrix-cols': '3' } as React.CSSProperties}>
          <div />
          {['X', 'Y', 'Z'].map(x => (
            <div key={x} style={{ textAlign: 'center', fontSize: 11, fontWeight: 800, color: c.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {x} · {XYZ_DESC[x]}
            </div>
          ))}
          {['A', 'B', 'C'].map(a => (
            <React.Fragment key={a}>
              <div style={{ display: 'flex', alignItems: 'center', fontSize: 11, fontWeight: 800, color: ABC_COLOR[a] }}>
                {a} · {a === 'A' ? 'high £' : a === 'B' ? 'mid £' : 'low £'}
              </div>
              {['X', 'Y', 'Z'].map(x => {
                const seg = `${a}${x}`
                const cell = bySeg[seg]
                const count = cell?.count ?? 0
                const value = cell?.value_gbp ?? 0
                const atRisk = cell?.at_risk ?? 0
                const active = activeSegment === seg
                return (
                  <div
                    key={seg}
                    onClick={() => count && onSelect(seg)}
                    onMouseEnter={() => count && setHoverSeg(seg)}
                    onMouseLeave={() => setHoverSeg(null)}
                    title={cell?.label ? `${seg} — ${cell.label}` : undefined}
                    style={{
                      borderRadius: 8, padding: '8px 6px', textAlign: 'center',
                      cursor: count ? 'pointer' : 'default',
                      background: active ? '#2563EB' : count ? c.surfaceSubtle : c.surfaceMuted,
                      border: `1.5px solid ${active ? '#2563EB' : atRisk > 0 ? '#FCA5A5' : c.borderSubtle}`,
                      opacity: count ? 1 : 0.45,
                    }}
                  >
                    <div style={{ fontSize: 16, fontWeight: 900, color: active ? '#fff' : c.textPrimary, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                      {count.toLocaleString()}
                    </div>
                    <div style={{ fontSize: 11, color: active ? 'rgba(255,255,255,0.85)' : c.textMuted, marginTop: 3 }}>
                      {count ? fmtGBP(value) : '—'}
                      {atRisk > 0 && <span style={{ color: active ? '#FECACA' : '#DC2626', fontWeight: 800 }}> · {atRisk}!</span>}
                    </div>
                  </div>
                )
              })}
            </React.Fragment>
          ))}
        </div>
        {/* What the selected (or hovered) cell MEANS commercially — the matrix is
            only useful if it tells a planner how to treat that slice. */}
        {(() => {
          const seg = hoverSeg || (activeSegment !== 'all' ? activeSegment : null)
          const cell = seg ? bySeg[seg] : null
          if (!cell || !cell.label) {
            return (
              <div style={{ fontSize: 11, color: c.textMuted, marginTop: 10, lineHeight: 1.5 }}>
                Value (A–C) × predictability (X–Z). Hover a cell for what it means commercially;
                click to filter <b>every metric and table on this page</b> to that slice.
              </div>
            )
          }
          const riskCol = cell.risk === 'high' ? '#DC2626' : cell.risk === 'medium' ? '#D97706' : '#059669'
          return (
            <div style={{
              marginTop: 10, borderRadius: 8, padding: '9px 11px',
              background: c.surfaceSubtle, border: `1px solid ${c.borderSubtle}`, borderLeft: `3px solid ${riskCol}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 800, color: riskCol }}>{seg}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: c.textPrimary }}>{cell.label}</span>
                <span style={{ fontSize: 11, color: c.textMuted, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
                  {(cell.count ?? 0).toLocaleString()} SKUs · {fmtGBP(cell.value_gbp ?? 0)}
                  {cell.excess_gbp ? ` · ${fmtGBP(cell.excess_gbp)} excess` : ''}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap', fontSize: 11, color: c.textSecondary }}>
                <span><b style={{ color: c.textPrimary }}>Service:</b> {cell.service_level_target_pct ?? '—'}%</span>
                <span><b style={{ color: c.textPrimary }}>Review:</b> {cell.review}</span>
                <span><b style={{ color: c.textPrimary }}>Buffer:</b> {cell.buffer}</span>
              </div>
              <div style={{ fontSize: 11, color: c.textSecondary, marginTop: 6, lineHeight: 1.45 }}>
                {cell.action}
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

// ─── Time-phased stock projection with what-if simulation ────────────────────

function ProjectionPanel({ item, inbounds, scope }: {
  item: any
  inbounds: { dayOffset: number; qty: number; label: string }[]
  scope: string
}) {
  const refData = useReferenceData()
  const { c } = useTheme()
  const [demandDelta, setDemandDelta] = useState(0)   // % on top of current demand
  const [leadSlip, setLeadSlip] = useState(0)         // days all inbound supply slips

  const daily = (item.daily_consumption_adjusted || item.daily_consumption_base || 1)
  const safety = item.safety_stock_level ?? 0
  const startAvailable = item.quantity_available ?? 0
  const isSimulated = demandDelta !== 0 || leadSlip !== 0

  const { series, stockoutDay, minDay } = useMemo(() => {
    const dailySim = daily * (1 + demandDelta / 100)
    const arrivals = new Map<number, { qty: number; labels: string[] }>()
    for (const inb of inbounds) {
      const day = inb.dayOffset + leadSlip
      if (day > 30) continue
      const cur = arrivals.get(day) || { qty: 0, labels: [] }
      cur.qty += inb.qty
      cur.labels.push(inb.label)
      arrivals.set(day, cur)
    }
    let level = startAvailable
    let so: number | null = null
    let min = { day: 0, level }
    const rows = []
    for (let d = 1; d <= 30; d++) {
      const inbound = arrivals.get(d)
      level = level - dailySim + (inbound?.qty || 0)
      if (level < min.level) min = { day: d, level }
      if (level <= 0 && so === null) so = d
      rows.push({
        day: d,
        projected: Math.round(Math.max(0, level)),
        inbound: inbound?.qty || 0,
        inboundLabel: inbound?.labels.join(', '),
      })
    }
    return { series: rows, stockoutDay: so, minDay: min }
  }, [daily, demandDelta, leadSlip, inbounds, startAvailable])

  const totalInbound = inbounds.reduce((s, i) => s + i.qty, 0)

  return (
    <div className="split-aside">
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--status-info-text)' }}>
            30-Day Projected Stock — {item.sku_code}{scope !== 'NETWORK' ? ` at ${refData.siteName[scope] || scope}` : ''}
          </div>
          {isSimulated && (
            <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 10, background: 'var(--status-warning-bg)', color: 'var(--status-warning-text)', border: '1px solid var(--status-warning-border)' }}>
              SIMULATED
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 8 }}>
          Available stock projected forward: −{(daily * (1 + demandDelta / 100)).toFixed(1)}/day demand, +{totalInbound.toLocaleString()} units inbound
          {scope !== 'NETWORK' && scope !== 'LEI_COE' ? ' (trunker transfers)' : ' (supplier POs)'} · dashed line = safety stock
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={44} />
            <Tooltip
              formatter={(v: any, name: string) => [Number(v).toLocaleString(), name === 'projected' ? 'Projected available' : 'Inbound supply']}
              labelFormatter={(l: any) => `Day ${l}`}
            />
            <Bar dataKey="inbound" fill="#8B5CF6" radius={[2, 2, 0, 0]} barSize={6} />
            <Line type="monotone" dataKey="projected" stroke={stockoutDay ? '#EF4444' : '#2563EB'} strokeWidth={2} dot={false} />
            <ReferenceLine y={safety} stroke="#F59E0B" strokeDasharray="5 3" />
            {stockoutDay && <ReferenceLine x={stockoutDay} stroke="#EF4444" strokeDasharray="4 2" />}
          </ComposedChart>
        </ResponsiveContainer>

        {/* What-if sliders */}
        <div className="auto-grid" style={{ '--cols': '2', '--col-min': '190px', '--grid-gap': '14px', marginTop: 10, background: c.surfaceSubtle, border: `1px solid ${c.borderSubtle}`, borderRadius: 8, padding: '10px 14px' } as React.CSSProperties}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
              <SlidersHorizontal size={10} /> Demand stress: <span style={{ color: demandDelta > 0 ? '#DC2626' : demandDelta < 0 ? '#059669' : c.textPrimary, fontWeight: 800 }}>{demandDelta > 0 ? '+' : ''}{demandDelta}%</span>
            </div>
            <input
              type="range" min={-30} max={60} step={5} value={demandDelta}
              onChange={e => setDemandDelta(parseInt(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Truck size={10} /> Supply slip: <span style={{ color: leadSlip > 0 ? '#DC2626' : c.textPrimary, fontWeight: 800 }}>+{leadSlip}d</span>
            </div>
            <input
              type="range" min={0} max={14} step={1} value={leadSlip}
              onChange={e => setLeadSlip(parseInt(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>
        </div>
      </div>

      {/* Projection stats */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: c.textSecondary }}>
          Projection Summary
        </div>
        <div style={{
          borderRadius: 8, padding: '10px 12px',
          background: stockoutDay ? c.danger.bg : c.success.bg,
          border: `1px solid ${stockoutDay ? c.danger.border : c.success.border}`,
        }}>
          <div style={{ fontSize: 11, color: stockoutDay ? c.danger.text : c.success.text, marginBottom: 2 }}>Projected stockout</div>
          <div style={{ fontSize: 18, fontWeight: 900, color: stockoutDay ? c.danger.text : c.success.text, lineHeight: 1 }}>
            {stockoutDay ? `Day ${stockoutDay}` : 'None in 30d'}
          </div>
          {stockoutDay && (
            <div style={{ fontSize: 11, color: c.danger.text, marginTop: 3 }}>
              {isSimulated ? 'under simulated conditions' : 'at current demand & supply'}
            </div>
          )}
        </div>
        {[
          { label: 'Lowest point', value: `${Math.max(0, Math.round(minDay.level)).toLocaleString()} units (day ${minDay.day})` },
          { label: 'Inbound in horizon', value: `${totalInbound.toLocaleString()} units · ${inbounds.length} order${inbounds.length !== 1 ? 's' : ''}` },
          { label: '30d demand', value: `${Math.round(daily * (1 + demandDelta / 100) * 30).toLocaleString()} units` },
          { label: 'Safety stock floor', value: `${safety.toLocaleString()} units` },
          { label: 'Service target', value: item.service_level_target_pct ? `${item.service_level_target_pct}% (${item.segment})` : '—' },
        ].map(({ label, value }) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '5px 0', borderBottom: `1px solid ${c.borderSubtle}` }}>
            <span style={{ color: c.textSecondary }}>{label}</span>
            <span style={{ fontWeight: 700, color: c.textPrimary, textAlign: 'right' }}>{value}</span>
          </div>
        ))}
        {inbounds.length > 0 && (
          <div style={{ fontSize: 11, color: c.textMuted, lineHeight: 1.5 }}>
            Inbound: {inbounds.map(i => `${i.label} (+${i.qty} d${i.dayOffset + leadSlip})`).join(' · ')}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Forecast quality (FVA / bias / MAPE) ────────────────────────────────────

function QualityPanel({ item }: { item: any }) {
  const { c } = useTheme()
  const fq = item.forecast_quality
  if (!fq) return null
  // Each stat carries the key of its rich definition (meaning / how / benchmark)
  const stats = [
    { label: 'MAPE', def: 'MAPE', value: `${fq.mape_pct?.toFixed(1)}%`, good: fq.mape_pct <= 12 },
    { label: 'Bias', def: 'Forecast Bias', value: `${fq.bias_pct > 0 ? '+' : ''}${fq.bias_pct?.toFixed(1)}%`, good: Math.abs(fq.bias_pct) <= 3 },
    { label: 'FVA', def: 'FVA', value: `+${fq.fva_pct?.toFixed(1)}%`, good: fq.fva_pct > 0 },
    { label: 'Service target', def: 'Service Level Target', value: item.service_level_target_pct ? `${item.service_level_target_pct}%` : '—', good: true },
  ]
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${c.borderSubtle}` }}>
      <div className="split-aside">
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--status-ai-text)', marginBottom: 8 }}>
            Forecast vs Actual — last 8 weeks
          </div>
          <ResponsiveContainer width="100%" height={110}>
            <ComposedChart data={fq.weekly || []} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis dataKey="week" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} width={44} />
              <Tooltip formatter={(v: any, name: string) => [Number(v).toLocaleString(), name === 'actual' ? 'Actual' : 'Forecast']} />
              <Bar dataKey="actual" fill="#93C5FD" radius={[2, 2, 0, 0]} barSize={14} />
              <Line type="monotone" dataKey="forecast" stroke="#6D28D9" strokeWidth={2} dot={{ r: 2 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 14 }}>
          {stats.map(s => (
            <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '4px 0', borderBottom: `1px solid ${c.borderSubtle}` }}>
              <span style={{ color: c.textSecondary }}><HelpTip tip={s.def}>{s.label}</HelpTip></span>
              <span style={{ fontWeight: 800, color: s.good ? '#059669' : '#D97706' }}>{s.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

const KPI_ACCENT: Record<string, string> = { G: '#059669', A: '#D97706', R: '#DC2626', N: '#2563EB' }
const KPI_TRACK: Record<string, string> = { G: '#D1FAE5', A: '#FEF3C7', R: '#FEE2E2', N: '#DBEAFE' }

function DemandKpiCard({ label, value, sub, rag, progress, icon: Icon }: {
  label: string; value: string; sub: string; rag: 'G' | 'A' | 'R' | 'N'; progress?: number; icon?: React.ElementType
}) {
  const { c } = useTheme()
  const accent = KPI_ACCENT[rag]
  const track = rag === 'N' ? c.info.bg : (c.ragBg[rag as 'G' | 'A' | 'R'] || KPI_TRACK[rag])
  return (
    <MetricTip label={label} title={label} block>
      <div style={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: 10, padding: '14px 16px', display: 'flex', gap: 13, alignItems: 'flex-start', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <div style={{ width: 4, borderRadius: 4, background: accent, alignSelf: 'stretch', flexShrink: 0, minHeight: 52 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            {Icon && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                background: `${accent}18`,
                border: `1.5px solid ${accent}30`,
              }}>
                <Icon size={14} strokeWidth={2} color={accent} />
              </div>
            )}
            <div style={{ fontSize: 11, fontWeight: 700, color: c.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</div>
          </div>
          <div style={{ fontSize: 28, fontWeight: 900, color: accent, lineHeight: 1 }}>{value}</div>
          <div style={{ fontSize: 11, color: c.textSecondary, marginTop: 5, lineHeight: 1.4 }}>{sub}</div>
          {progress !== undefined && (
            <div style={{ height: 4, background: track, borderRadius: 2, overflow: 'hidden', marginTop: 10 }}>
              <div style={{ width: `${progress}%`, height: '100%', background: accent, borderRadius: 2 }} />
            </div>
          )}
        </div>
      </div>
    </MetricTip>
  )
}

function StatusBadge({ item }: { item: any }) {
  const { c } = useTheme()
  const [show, setShow] = useState(false)
  const [above, setAbove] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  const rag = item.rag_status as string
  const dos = item.days_of_supply ?? 0
  const onHand = item.quantity_on_hand ?? 0
  const available = item.quantity_available ?? 0
  const safety = item.safety_stock_level ?? 0
  const reorder = item.reorder_point ?? 0
  const leadTime = item.lead_time_days ?? 7
  const reviewPeriod = item.review_period_days ?? 7
  const reorderWindow = leadTime + reviewPeriod

  // Determine the primary trigger for this status
  let trigger = ''
  let criteria: { label: string; value: string; threshold: string; ok: boolean }[] = []

  if (rag === 'R') {
    trigger = onHand === 0 ? 'Stockout — zero units on hand' : `Days of cover (${dos.toFixed(1)}d) less than lead time (${leadTime}d)`
    criteria = [
      { label: 'Days of cover vs lead time', value: `${dos.toFixed(1)}d / ${leadTime}d`, threshold: `DoS ≥ ${leadTime}d lead time`, ok: dos >= leadTime },
      { label: 'Available qty', value: available.toLocaleString(), threshold: '> 0 units', ok: available > 0 },
      { label: 'vs Safety stock', value: `${available.toLocaleString()} / ${safety.toLocaleString()}`, threshold: 'Available ≥ safety stock', ok: available >= safety },
    ]
  } else if (rag === 'A') {
    trigger = available < safety
      ? `Available (${available.toLocaleString()}) below safety stock (${safety.toLocaleString()})`
      : `Days of cover (${dos.toFixed(1)}d) within reorder window (< ${reorderWindow}d)`
    criteria = [
      { label: 'Days of cover vs reorder window', value: `${dos.toFixed(1)}d / ${reorderWindow}d`, threshold: `DoS ≥ ${leadTime}d + ${reviewPeriod}d`, ok: dos >= reorderWindow },
      { label: 'Available vs safety stock', value: `${available.toLocaleString()} / ${safety.toLocaleString()}`, threshold: 'Available ≥ safety stock', ok: available >= safety },
      { label: 'On hand vs reorder point', value: `${onHand.toLocaleString()} / ${reorder.toLocaleString()}`, threshold: 'On hand ≥ reorder point', ok: onHand >= reorder },
    ]
  } else {
    trigger = `Days of cover (${dos.toFixed(1)}d) exceeds reorder window (${reorderWindow}d)`
    criteria = [
      { label: 'Days of cover vs reorder window', value: `${dos.toFixed(1)}d / ${reorderWindow}d`, threshold: `DoS ≥ ${reorderWindow}d`, ok: dos >= reorderWindow },
      { label: 'Available vs safety stock', value: `${available.toLocaleString()} / ${safety.toLocaleString()}`, threshold: 'Available ≥ safety stock', ok: available >= safety },
      { label: 'On hand vs reorder point', value: `${onHand.toLocaleString()} / ${reorder.toLocaleString()}`, threshold: 'On hand ≥ reorder point', ok: onHand >= reorder },
    ]
  }

  function handleEnter() {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setAbove(rect.bottom + 220 > window.innerHeight)
    }
    setShow(true)
  }

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={handleEnter} onMouseLeave={() => setShow(false)}>
      <span style={{
        fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 20, cursor: 'default',
        background: c.ragBg[rag as 'G' | 'A' | 'R'] || c.surfaceSubtle,
        color: RAG_COLOR[rag] || c.textSecondary,
        border: `1px solid ${RAG_COLOR[rag] || c.border}55`,
      }}>
        {RAG_LABEL[rag] || rag}
      </span>

      {show && (
        <div style={{
          position: 'absolute',
          [above ? 'bottom' : 'top']: 'calc(100% + 7px)',
          left: '50%', transform: 'translateX(-50%)',
          width: 270, zIndex: 2000, pointerEvents: 'none',
          background: c.surface, border: `1px solid ${c.border}`,
          borderRadius: 10, boxShadow: '0 8px 28px rgba(0,0,0,0.13)',
          padding: '12px 14px',
        }}>
          {/* arrow */}
          <div style={{
            position: 'absolute',
            [above ? 'bottom' : 'top']: -6,
            left: '50%', marginLeft: -5,
            width: 10, height: 10, background: c.surface,
            border: `1px solid ${c.border}`,
            borderRight: 'none',
            borderBottom: above ? 'none' : undefined,
            borderTop: above ? undefined : 'none',
            transform: above ? 'rotate(-45deg)' : 'rotate(135deg)',
          }} />

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
            <span style={{
              fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 20,
              background: c.ragBg[rag as 'G' | 'A' | 'R'] || c.surfaceSubtle,
              color: RAG_COLOR[rag] || c.textSecondary,
              border: `1px solid ${RAG_COLOR[rag] || c.border}55`,
            }}>
              {RAG_LABEL[rag]}
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, color: c.textPrimary }}>Status Criteria</span>
          </div>

          {/* Trigger */}
          <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 10, lineHeight: 1.4 }}>
            {trigger}
          </div>

          {/* Criteria rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {criteria.map(crit => (
              <div key={crit.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: crit.ok ? '#059669' : '#DC2626', fontWeight: 800, lineHeight: 1 }}>
                  <span style={{ display: 'flex', alignItems: 'center' }}>{crit.ok ? <Check size={12} /> : <X size={12} />}</span>
                </span>
                <span style={{ fontSize: 11, color: c.textSecondary, flex: 1 }}>{crit.label}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: crit.ok ? '#065F46' : '#991B1B' }}>{crit.value}</span>
                <span style={{ fontSize: 11, color: c.textMuted }}>{crit.threshold}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  )
}



function ProgStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  const { c } = useTheme()
  return (
    <div style={{ background: c.surfaceSubtle, borderRadius: 8, padding: '10px 12px', border: `1px solid ${c.borderSubtle}` }}>
      <div style={{ fontSize: 11, color: c.textSecondary, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: c.textPrimary, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: c.textMuted, marginTop: 2 }}>{sub}</div>
    </div>
  )
}

function RaisePOModal({ item, onClose, onSubmit, submitting, error }: {
  item: any
  onClose: () => void
  onSubmit: (payload: { sku_code: string; supplier_code: string; warehouse_code: string; quantity: number; po_type: string; notes?: string }) => void
  submitting: boolean
  error: boolean
}) {
  const refData = useReferenceData()
  const leadTime = item.lead_time_days ?? 7
  const reviewPeriod = item.review_period_days ?? 7
  const dailyAdj = item.daily_consumption_adjusted ?? item.daily_consumption_base ?? 0
  const dailyBase = item.daily_consumption_base ?? 0
  const uplift = item.demand_uplift_applied ?? 1.0
  const safetyStock = item.safety_stock_level ?? 0
  const available = item.quantity_available ?? 0
  const maxStock = safetyStock + Math.round((leadTime + reviewPeriod) * dailyAdj)
  const targetOrderQty = item.target_order_qty ?? Math.max(0, maxStock - available)
  const suggestedQty = targetOrderQty > 0 ? targetOrderQty : Math.max(1, (item.reorder_point || 0) - (item.quantity_on_hand || 0) + safetyStock)
  const supplierOptions = refData.suppliersByCategory[item.category] || refData.allSuppliers

  const [supplierCode, setSupplierCode] = useState(supplierOptions[0]?.code || '')
  const [quantity, setQuantity] = useState(suggestedQty)
  const [poType, setPoType] = useState<'standard' | 'emergency'>(item.rag_status === 'R' ? 'emergency' : 'standard')
  const [notes, setNotes] = useState('')

  const { c } = useTheme()
  const isEmergency = poType === 'emergency'
  const accentColor = isEmergency ? '#EF4444' : '#2563EB'
  const accentBg = isEmergency ? c.danger.bg : c.info.bg
  const accentBdr = isEmergency ? c.danger.border : c.info.border

  const handleSubmit = () => {
    if (!supplierCode || quantity < 1) return
    // Suppliers only ever deliver into the NDC — hub replenishment is by transfer
    onSubmit({ sku_code: item.sku_code, supplier_code: supplierCode, warehouse_code: refData.ndcCode, quantity, po_type: poType, notes: notes || undefined })
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: c.surface, borderRadius: 14, maxWidth: 520, width: '100%', boxShadow: '0 24px 70px rgba(0,0,0,0.25)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ background: accentBg, borderBottom: `1px solid ${accentBdr}`, padding: '16px 20px' }}>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: accentColor, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            {isEmergency ? <><AlertTriangle size={12} /> Emergency Purchase Order</> : <><ClipboardList size={12} /> Raise Purchase Order</>}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: c.textPrimary }}>{item.description}</div>
          <div style={{ fontSize: 11, fontFamily: 'monospace', color: c.textSecondary, marginTop: 2 }}>{item.sku_code}</div>
        </div>

        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Current stock snapshot */}
          <div className="auto-grid" style={{ '--cols': '4', '--col-min': '104px', '--grid-gap': '8px' } as React.CSSProperties}>
            {[
              { label: 'On Hand', value: item.quantity_on_hand?.toLocaleString(), alert: false },
              { label: 'Available', value: available.toLocaleString(), alert: available < safetyStock },
              { label: 'Days Cover', value: `${item.days_of_supply?.toFixed(1)}d`, alert: item.days_of_supply < leadTime },
              { label: 'Lead Time', value: `${leadTime}d`, alert: false },
            ].map(({ label, value, alert }) => (
              <div key={label} style={{ background: alert ? c.danger.bg : c.surfaceSubtle, borderRadius: 7, padding: '8px 10px', border: `1px solid ${alert ? c.danger.border : c.border}` }}>
                <div style={{ fontSize: 11, color: alert ? c.danger.text : c.textSecondary, marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: alert ? c.danger.text : c.textPrimary }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Target order quantity breakdown */}
          <div style={{ background: c.info.bg, borderRadius: 9, padding: '12px 14px', border: `1px solid ${c.info.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: c.info.text, marginBottom: 8 }}>
              Target Order Quantity — Order-Up-To Formula
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: c.textSecondary }}>Safety stock</span>
                <span style={{ fontWeight: 700, color: c.textPrimary }}>{safetyStock.toLocaleString()} units</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: c.textSecondary }}>Pipeline demand  ({leadTime}d LT + {reviewPeriod}d review) × {dailyAdj.toFixed(1)}/day</span>
                <span style={{ fontWeight: 700, color: c.textPrimary }}>{Math.round((leadTime + reviewPeriod) * dailyAdj).toLocaleString()} units</span>
              </div>
              <div style={{ height: 1, background: c.info.border, margin: '2px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: c.textSecondary }}>Target max stock</span>
                <span style={{ fontWeight: 700, color: c.textPrimary }}>{maxStock.toLocaleString()} units</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: c.textSecondary }}>Current available</span>
                <span style={{ fontWeight: 700, color: c.textPrimary }}>−{available.toLocaleString()} units</span>
              </div>
              <div style={{ height: 1, background: c.info.border, margin: '2px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: c.info.text, fontWeight: 800 }}>Target order quantity</span>
                <span style={{ fontWeight: 900, color: c.info.text, fontSize: 13 }}>{targetOrderQty.toLocaleString()} units</span>
              </div>
            </div>
            {uplift > 1.01 && (
              <div style={{ marginTop: 8, fontSize: 11, color: c.warning.text, background: c.warning.bg, border: `1px solid ${c.warning.border}`, borderRadius: 5, padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
                <AlertTriangle size={12} /> Demand uplift ×{uplift.toFixed(2)} applied — base {dailyBase.toFixed(1)}/day → adjusted {dailyAdj.toFixed(1)}/day
              </div>
            )}
          </div>

          {/* PO Type toggle */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>Order Type</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['standard', 'emergency'] as const).map((type) => (
                <button key={type}
                  onClick={() => setPoType(type)}
                  style={{
                    flex: 1, padding: '8px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12,
                    background: poType === type ? (type === 'emergency' ? '#EF4444' : '#2563EB') : c.surfaceMuted,
                    color: poType === type ? '#fff' : c.textSecondary,
                    border: `1px solid ${poType === type ? (type === 'emergency' ? '#EF4444' : '#2563EB') : c.border}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                    {type === 'emergency' ? <><AlertTriangle size={14} /> Emergency</> : <><ClipboardList size={14} /> Standard</>}
                  </div>
                </button>
              ))}
            </div>
            {isEmergency && (
              <div style={{ fontSize: 11, color: 'var(--status-danger-text)', marginTop: 5 }}>
                Emergency orders bypass standard lead times and are expedited via Wolseley / city plumbing counters.
              </div>
            )}
          </div>

          {/* Supplier */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
              Supplier
            </label>
            <select
              value={supplierCode}
              onChange={(e) => setSupplierCode(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${c.border}`, fontSize: 13, background: c.surfaceSubtle, color: c.textPrimary }}
            >
              {supplierOptions.map((s) => (
                <option key={s.code} value={s.code}>{s.name} ({s.code})</option>
              ))}
            </select>
          </div>

          {/* Destination — fixed to the NDC in the two-echelon flow */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
              Destination
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 7, border: `1px solid ${c.border}`, background: c.surfaceSubtle }}>
              <Warehouse size={14} color={c.textSecondary} />
              <span style={{ fontSize: 13, fontWeight: 700, color: c.textPrimary }}>Leicester NDC</span>
              <span style={{ fontSize: 11, color: c.textMuted }}>· suppliers deliver to the NDC only — hubs are replenished by internal transfer</span>
            </div>
          </div>

          {/* Quantity */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
              Order Quantity
              <span style={{ fontSize: 11, fontWeight: 400, textTransform: 'none', color: c.textMuted, marginLeft: 6 }}>
                (target: {suggestedQty.toLocaleString()} units — Order-Up-To calculation above)
              </span>
            </label>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${quantity < 1 ? '#EF4444' : c.border}`, fontSize: 13, boxSizing: 'border-box', background: c.surfaceSubtle, color: c.textPrimary }}
            />
          </div>

          {/* Notes */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
              Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Reason for order, special instructions, urgency context…"
              rows={2}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${c.border}`, fontSize: 12, resize: 'none', fontFamily: 'inherit', boxSizing: 'border-box', background: c.surfaceSubtle, color: c.textPrimary }}
            />
          </div>

          {error && (
            <div style={{ background: c.danger.bg, border: `1px solid ${c.danger.border}`, borderRadius: 7, padding: '8px 12px', fontSize: 12, color: c.danger.text }}>
              Failed to create purchase order. Please try again.
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4 }}>
            <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              className="btn btn-sm"
              style={{ background: accentColor, color: '#fff', border: 'none', padding: '8px 20px', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, opacity: submitting ? 0.7 : 1 }}
              onClick={handleSubmit}
              disabled={submitting || quantity < 1}
            >
              {submitting ? 'Creating…' : isEmergency ? <><AlertTriangle size={14} /> Raise Emergency PO</> : <><ClipboardList size={14} /> Raise Purchase Order</>}
            </button>
          </div>

        </div>
      </div>
    </div>
  )
}

function TransferModal({ item, initialToCode, fromCode, initialQty, onClose, onSubmit, submitting, error }: {
  item: any
  initialToCode?: string
  fromCode?: string
  initialQty?: number
  onClose: () => void
  onSubmit: (payload: { sku_code: string; to_warehouse: string; quantity: number; from_warehouse?: string; notes?: string }) => void
  submitting: boolean
  error: boolean
}) {
  const refData = useReferenceData()
  const { c } = useTheme()
  const sites: any[] = item?.by_warehouse || []
  const sourceCode = fromCode || refData.ndcCode
  const source = sites.find((s: any) => s.warehouse_code === sourceCode)
  const hubOptions = sites.filter((s: any) => s.role === 'hub' && s.warehouse_code !== sourceCode)

  const [toCode, setToCode] = useState(initialToCode && initialToCode !== sourceCode ? initialToCode : (hubOptions[0]?.warehouse_code || 'COV_HUB'))
  const dest = sites.find((s: any) => s.warehouse_code === toCode)
  const suggestedQty = initialQty || dest?.replenishment_qty || 10
  const [quantity, setQuantity] = useState(suggestedQty)
  const [notes, setNotes] = useState('')

  const headroom = source ? Math.max(0, source.quantity_available - source.safety_stock_level) : 0
  const overHeadroom = quantity > headroom

  const handleSubmit = () => {
    if (!toCode || quantity < 1) return
    onSubmit({
      sku_code: item.sku_code, to_warehouse: toCode, quantity,
      from_warehouse: sourceCode !== refData.ndcCode ? sourceCode : undefined,
      notes: notes || undefined,
    })
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: c.surface, borderRadius: 14, maxWidth: 520, width: '100%', boxShadow: '0 24px 70px rgba(0,0,0,0.25)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ background: 'var(--status-ai-bg)', borderBottom: '1px solid var(--status-ai-border)', padding: '16px 20px' }}>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--status-ai-text)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <ArrowLeftRight size={12} /> {sourceCode === refData.ndcCode ? 'Stock Transfer — NDC → Hub' : 'Lateral Rebalance — Hub → Hub'}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#1F2937' }}>{item.description}</div>
          <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-tertiary)', marginTop: 2 }}>{item.sku_code}</div>
        </div>

        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Source position */}
          <div className="auto-grid" style={{ '--cols': '4', '--col-min': '104px', '--grid-gap': '8px' } as React.CSSProperties}>
            {[
              { label: `${refData.siteShort[sourceCode]} On Hand`, value: source?.quantity_on_hand?.toLocaleString() ?? '—', alert: false },
              { label: `${refData.siteShort[sourceCode]} Available`, value: source?.quantity_available?.toLocaleString() ?? '—', alert: false },
              { label: `${refData.siteShort[sourceCode]} Safety`, value: source?.safety_stock_level?.toLocaleString() ?? '—', alert: false },
              { label: 'Headroom', value: headroom.toLocaleString(), alert: headroom === 0 },
            ].map(({ label, value, alert }) => (
              <div key={label} style={{ background: alert ? c.danger.bg : c.surfaceSubtle, borderRadius: 7, padding: '8px 10px', border: `1px solid ${alert ? c.danger.border : c.border}` }}>
                <div style={{ fontSize: 11, color: alert ? c.danger.text : c.textSecondary, marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: alert ? c.danger.text : c.textPrimary }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Destination hub */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
              Destination Hub
            </label>
            <select
              value={toCode}
              onChange={(e) => { setToCode(e.target.value); const d = sites.find((s: any) => s.warehouse_code === e.target.value); if (d?.replenishment_qty) setQuantity(d.replenishment_qty) }}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${c.border}`, fontSize: 13, background: c.surfaceSubtle, color: c.textPrimary }}
            >
              {hubOptions.map((h: any) => (
                <option key={h.warehouse_code} value={h.warehouse_code}>
                  {h.warehouse_name} — {h.days_of_supply > 900 ? '∞' : h.days_of_supply}d cover · {RAG_LABEL[h.rag_status]}
                </option>
              ))}
            </select>
            {dest && (
              <div style={{ fontSize: 11, color: c.textMuted, marginTop: 5 }}>
                {dest.warehouse_name}: {dest.quantity_available.toLocaleString()} available vs {dest.safety_stock_level.toLocaleString()} safety ·
                trunker lead {dest.replenishment_lead_days}d · suggested top-up {(dest.replenishment_qty || 0).toLocaleString()} units
              </div>
            )}
          </div>

          {/* Quantity */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
              Transfer Quantity
              <span style={{ fontSize: 11, fontWeight: 400, textTransform: 'none', color: c.textMuted, marginLeft: 6 }}>
                (suggested: {suggestedQty.toLocaleString()} units — order-up-to at destination)
              </span>
            </label>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${quantity < 1 ? '#EF4444' : c.border}`, fontSize: 13, boxSizing: 'border-box', background: c.surfaceSubtle, color: c.textPrimary }}
            />
            {overHeadroom && (
              <div style={{ fontSize: 11, color: 'var(--status-warning-text)', marginTop: 5, display: 'flex', alignItems: 'center', gap: 4 }}>
                <AlertTriangle size={12} /> Exceeds source headroom ({headroom.toLocaleString()} units above safety stock) — the source site will dip below its buffer.
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: c.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
              Reason / Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Reason for transfer, urgency context…"
              rows={2}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${c.border}`, fontSize: 12, resize: 'none', fontFamily: 'inherit', boxSizing: 'border-box', background: c.surfaceSubtle, color: c.textPrimary }}
            />
          </div>

          {error && (
            <div style={{ background: c.danger.bg, border: `1px solid ${c.danger.border}`, borderRadius: 7, padding: '8px 12px', fontSize: 12, color: c.danger.text }}>
              Failed to create transfer order. Please try again.
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4 }}>
            <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              className="btn btn-sm"
              style={{ background: '#6D28D9', color: '#fff', border: 'none', padding: '8px 20px', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, opacity: submitting ? 0.7 : 1 }}
              onClick={handleSubmit}
              disabled={submitting || quantity < 1}
            >
              {submitting ? 'Creating…' : <><ArrowLeftRight size={14} /> Create Transfer</>}
            </button>
          </div>

        </div>
      </div>
    </div>
  )
}

// ─── Unified demand chart: 30 days actual + 30 days forecast on one axis ─────

function DemandChart({ sku, forecast }: { sku: any; forecast: any }) {
  const { c } = useTheme()
  const data = forecast.chart_data || []
  const vsLast = forecast.vs_last_30d_pct
  const trendUp = (vsLast ?? 0) > 0

  return (
    <div className="split-aside">
      <div>
        <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--status-info-text)', marginBottom: 4 }}>
          <HelpTip tip="Demand Chart">Demand — last 30 days actual vs next 30 days forecast</HelpTip>
        </div>
        <div style={{ fontSize: 12, color: c.textSecondary, marginBottom: 10 }}>
          <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{sku.sku_code}</span> · {sku.description}
          {' · '}modelled from base × seasonality × weather × IoT
        </div>
        <ResponsiveContainer width="100%" height={210}>
          <ComposedChart data={data} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="actualGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0F766E" stopOpacity={0.28} />
                <stop offset="100%" stopColor="#0F766E" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={c.borderSubtle} />
            <XAxis
              dataKey="day" tick={{ fontSize: 11 }} interval={9}
              tickFormatter={(d: any) => (d === 0 ? 'today' : d > 0 ? `+${d}d` : `${d}d`)}
            />
            <YAxis tick={{ fontSize: 11 }} width={40} label={{ value: 'units/day', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: c.textMuted } }} />
            <Tooltip
              contentStyle={{ fontSize: 11, borderRadius: 8, border: `1px solid ${c.border}`, background: c.surface }}
              labelFormatter={(d: any) => (d === 0 ? 'Today' : d > 0 ? `Forecast · day +${d}` : `Actual · day ${d}`)}
              formatter={(v: any, name: string) => {
                const label: Record<string, string> = {
                  actual: 'Actual', forecast: 'Forecast', upper: 'Upper bound', lower: 'Lower bound',
                }
                return [Number(v).toLocaleString(), label[name] || name]
              }}
            />
            {/* Confidence band on the forecast half */}
            <Area type="monotone" dataKey="upper" stroke="none" fill="#2563EB" fillOpacity={0.10} isAnimationActive={false} />
            <Area type="monotone" dataKey="lower" stroke="none" fill={c.surface} fillOpacity={1} isAnimationActive={false} />
            {/* Actuals (solid), statistical baseline (faint), sensed forecast (dashed) */}
            <Area type="monotone" dataKey="actual" stroke="#0F766E" strokeWidth={2} fill="url(#actualGrad)" dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="baseline" stroke="#94A3B8" strokeWidth={1.5} strokeDasharray="2 3" dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="forecast" stroke="#2563EB" strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls />
            <ReferenceLine x={0} stroke={c.textMuted} strokeDasharray="3 3" label={{ value: 'today', position: 'top', style: { fontSize: 11, fill: c.textMuted } }} />
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', gap: 16, marginTop: 4, fontSize: 11, color: c.textSecondary }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 14, height: 3, background: '#0F766E', borderRadius: 2 }} /> Actual (30d)
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 14, height: 0, borderTop: '2px dashed #2563EB' }} /> Sensed forecast (30d)
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 14, height: 0, borderTop: '2px dashed #94A3B8' }} /> Statistical baseline
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 14, height: 8, background: '#2563EB', opacity: 0.12, borderRadius: 2 }} /> Confidence band
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: c.textSecondary, marginBottom: 8 }}>
          Demand Summary
        </div>
        <div style={{ borderRadius: 8, padding: '10px 12px', marginBottom: 8, background: c.info.bg, border: `1px solid ${c.info.border}` }}>
          <div style={{ fontSize: 11, color: c.info.text, marginBottom: 2 }}>Next 30 days vs last 30</div>
          <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1, color: vsLast == null ? c.textMuted : trendUp ? '#DC2626' : '#059669', display: 'flex', alignItems: 'center', gap: 6 }}>
            {vsLast == null ? '—' : `${trendUp ? '+' : ''}${vsLast.toFixed(1)}%`}
            {vsLast != null && (trendUp ? <TrendingUp size={16} /> : <TrendingDown size={16} />)}
          </div>
        </div>
        {[
          { label: 'Actual · last 30d', value: (forecast.actual_30d_qty || 0).toLocaleString() },
          { label: 'Forecast · next 30d', value: (forecast.forecasted_qty || 0).toLocaleString() },
          { label: 'Statistical baseline', value: (forecast.baseline_qty || 0).toLocaleString() },
          { label: 'Sensing overlay', tip: 'Demand Sensing Horizon',
            value: `${(forecast.sensing_qty ?? 0) > 0 ? '+' : ''}${(forecast.sensing_qty ?? 0).toLocaleString()} (${forecast.sensing_lift_pct ?? 0}%)` },
          { label: 'Confidence range', value: `${(forecast.confidence_lower_qty || 0).toLocaleString()} – ${(forecast.confidence_upper_qty || 0).toLocaleString()}` },
          { label: 'Seasonality factor', tip: 'Seasonality Factor', value: `×${(forecast.seasonality_factor ?? 1).toFixed(2)}` },
          { label: 'Signal multiplier', tip: 'Signal Multiplier', value: `×${(forecast.weather_uplift_factor || 1).toFixed(2)}` },
          { label: 'Forecast accuracy', tip: 'MAPE', value: `${(forecast.accuracy_pct || 0).toFixed(1)}% (MAPE ${forecast.mape_pct}%)` },
        ].map(({ label, value, tip }: any) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '5px 0', borderBottom: `1px solid ${c.borderSubtle}` }}>
            <span style={{ color: c.textSecondary }}>{tip ? <HelpTip tip={tip}>{label}</HelpTip> : label}</span>
            <span style={{ fontWeight: 700, color: c.textPrimary, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
