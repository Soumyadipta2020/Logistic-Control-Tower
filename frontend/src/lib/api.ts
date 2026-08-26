import axios from 'axios'

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'

export const api = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('clt_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && window.location.pathname !== '/login') {
      localStorage.removeItem('clt_token')
      localStorage.removeItem('clt_user')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000'

export async function fetchDashboard(role: string) {
  const res = await api.get(`/api/v1/visibility/dashboard?role=${role}`)
  return res.data.data
}

export async function fetchExceptions(priority?: string, status?: string) {
  const params = new URLSearchParams()
  if (priority) params.set('priority', priority)
  if (status) params.set('status', status)
  const res = await api.get(`/api/v1/exceptions?${params}`)
  return res.data.data
}

export async function fetchWarehouseHealth() {
  const res = await api.get('/api/v1/risk/warehouse-health')
  return res.data.data
}

export async function fetchSuppliers(sort = 'otif_desc', filter?: string) {
  const params = new URLSearchParams({ sort })
  if (filter) params.set('filter', filter)
  const res = await api.get(`/api/v1/risk/suppliers?${params}`)
  return res.data.data
}

export async function fetchExecutiveKPIs() {
  const res = await api.get('/api/v1/analytics/executive-kpis')
  return res.data.data
}

export async function fetchTransportKPIs() {
  const res = await api.get('/api/v1/analytics/transport-kpis')
  return res.data.data
}

export async function fetchOperationalKPIs() {
  const res = await api.get('/api/v1/analytics/operational-kpis')
  return res.data.data
}

export async function fetchMapData(layers = 'engineers,lockers,shipments,warehouses') {
  const res = await api.get(`/api/v1/visibility/map?layers=${layers}`)
  return res.data.data
}

export interface InventoryQuery {
  page?: number
  per_page?: number
  search?: string
  sku_category?: string
  segment?: string
  rag?: string
  sort?: string
  warehouse_code?: string
}

function inventoryParams(q: InventoryQuery = {}): string {
  const p = new URLSearchParams()
  Object.entries(q).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '' && v !== 'all') p.set(k, String(v))
  })
  return p.toString()
}

// Paged/searchable/sortable slice of the catalogue — scales to 1000+ SKUs.
export async function fetchInventory(q: InventoryQuery = {}) {
  const res = await api.get(`/api/v1/demand/inventory?${inventoryParams(q)}`)
  return res.data.data
}

// All aggregates over the FULL filtered catalogue (correct under pagination).
export async function fetchInventorySummary(q: InventoryQuery = {}) {
  const res = await api.get(`/api/v1/demand/inventory/summary?${inventoryParams(q)}`)
  return res.data.data
}

// Full position for one SKU — per-site breakdown, forecast quality, drivers.
export async function fetchInventoryItem(skuCode: string, warehouseCode?: string) {
  const p = warehouseCode && warehouseCode !== 'NETWORK' ? `?warehouse_code=${warehouseCode}` : ''
  const res = await api.get(`/api/v1/demand/inventory/${skuCode}${p}`)
  return res.data.data
}


export async function fetchDemandSignals() {
  const res = await api.get('/api/v1/demand/signals')
  return res.data.data
}

export async function fetchReplenishmentOrders(status?: string, supplierCode?: string, page = 1, perPage = 10) {
  const res = await api.get(`/api/v1/demand/replenishment-orders?${scopeParams({}, { status, supplier_code: supplierCode, page, per_page: perPage })}`)
  return res.data.data
}

export async function createReplenishmentOrder(payload: {
  sku_code: string; supplier_code: string; warehouse_code: string
  quantity: number; po_type: string; notes?: string
}) {
  const res = await api.post('/api/v1/demand/replenishment-orders', payload)
  return res.data.data
}

export async function fetchDemandNetwork() {
  const res = await api.get('/api/v1/demand/network')
  return res.data.data
}

export async function fetchTransferOrders(status?: string, page = 1, perPage = 10, raisedBy?: string) {
  const res = await api.get(`/api/v1/demand/transfer-orders?${scopeParams({}, { status, page, per_page: perPage, raised_by: raisedBy })}`)
  return res.data.data
}

export async function createTransferOrder(payload: {
  sku_code: string; to_warehouse: string; quantity: number; from_warehouse?: string; notes?: string
}) {
  const res = await api.post('/api/v1/demand/transfer-orders', payload)
  return res.data.data
}

export async function fetchHeatPumpPipeline() {
  const res = await api.get('/api/v1/demand/heat-pump-pipeline')
  return res.data.data
}

export async function fetchSmartMeterDashboard() {
  const res = await api.get('/api/v1/demand/smart-meter-dashboard')
  return res.data.data
}

export async function fetchSkuForecast(skuCode: string, horizon = 30) {
  const res = await api.get(`/api/v1/demand/forecast/${skuCode}?horizon=${horizon}`)
  return res.data.data
}

// ── Causal engine: Sense · Position · Execute · Orchestrate · Learn ──────────

export async function fetchDependentDemand(horizon = 30) {
  const res = await api.get(`/api/v1/demand/dependent-demand?horizon=${horizon}`)
  return res.data.data
}


// Filters the whole Demand page shares — segment/category/site — so a click on an
// ABC/XYZ cell narrows every metric and table, not just the inventory list.
export interface DemandScope {
  segment?: string | null
  sku_category?: string | null
  warehouse_code?: string | null
}
function scopeParams(q: DemandScope = {}, extra: Record<string, any> = {}): string {
  const p = new URLSearchParams()
  Object.entries({ ...q, ...extra }).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '' && v !== 'all') p.set(k, String(v))
  })
  return p.toString()
}

export async function fetchMeio(q: DemandScope = {}, page = 1, perPage = 10) {
  const res = await api.get(`/api/v1/demand/meio?${scopeParams(q, { page, per_page: perPage })}`)
  return res.data.data
}

export async function fetchFinancials(q: DemandScope = {}) {
  const res = await api.get(`/api/v1/demand/financials?${scopeParams(q)}`)
  return res.data.data
}

// Module master data: sites, supplier master, categories — no UI-side copies.
export async function fetchReferenceData() {
  const res = await api.get('/api/v1/demand/reference-data')
  return res.data.data
}

// How a shortfall is filled at each echelon: NDC → supplier PO, hub → STO
export async function fetchReplenishmentRouting() {
  const res = await api.get('/api/v1/demand/replenishment-routing')
  return res.data.data
}

export async function createDisposition(payload: {
  sku_code: string; action: string; units?: number; notes?: string
}) {
  const res = await api.post('/api/v1/demand/excess-dispositions', payload)
  return res.data.data
}

export async function fetchPlannerWorklist(
  q: DemandScope = {}, page = 1, perPage = 10,
  opts: { family?: string; kind?: string; sort?: string } = {},
) {
  const { family, kind, sort = 'priority' } = opts
  const res = await api.get(`/api/v1/demand/worklist?${scopeParams(q, { page, per_page: perPage, family, kind, sort })}`)
  return res.data.data
}

export async function fetchForecastTuning(q: DemandScope = {}, page = 1, perPage = 10, sort = 'bias') {
  const res = await api.get(`/api/v1/demand/forecast-tuning?${scopeParams(q, { page, per_page: perPage, sort })}`)
  return res.data.data
}

/** Top `topPct`% of SKUs by impact (|bias| × stock value) — the shape the
 *  tuning-loop chart needs, ranked by £ at stake rather than raw size. */
export async function fetchForecastTuningImpact(q: DemandScope = {}, topPct = 20) {
  const res = await api.get(`/api/v1/demand/forecast-tuning?${scopeParams(q, { sort: 'impact', top_pct: topPct })}`)
  return res.data.data
}

export async function fetchSopPlan(periods = 6) {
  const res = await api.get(`/api/v1/demand/sop-plan?periods=${periods}`)
  return res.data.data
}

export async function simulateNetwork(payload: {
  demand_shock_pct: number; lead_slip_days: number; category?: string | null
}) {
  const res = await api.post('/api/v1/demand/simulate', payload)
  return res.data.data
}

export async function receivePurchaseOrder(poNumber: string) {
  const res = await api.post(`/api/v1/demand/replenishment-orders/${poNumber}/receive`)
  return res.data.data
}

export async function expeditePurchaseOrder(poNumber: string) {
  const res = await api.post(`/api/v1/demand/replenishment-orders/${poNumber}/expedite`)
  return res.data.data
}

export async function receiveTransfer(transferId: string) {
  const res = await api.post(`/api/v1/demand/transfer-orders/${transferId}/receive`)
  return res.data.data
}

// ── IoT & connected estate ────────────────────────────────────────────────────
// A fault signal is only worth acting on if the part that clears it is within
// reach, so the backend returns each signal already joined to that part and to
// where it currently sits. `parts_cover` is the whole story in one field:
// on_van = an engineer in that region is carrying a spare, at_ndc = it exists
// but needs a transfer, none = we cannot fix this one first time.
export type PartsCover = 'on_van' | 'at_ndc' | 'none'

export interface BoilerFaultSignal {
  device_id: string
  property_postcode: string
  region: string
  boiler_brand: string
  boiler_model: string
  boiler_age_years: number | null
  fault_type: string
  required_sku: string | null
  required_part: string | null
  fault_probability: number
  replacement_probability_90d: number
  parts_cover: PartsCover
  cover_detail: string
  van_stock_in_region: number
  ndc_available: number
  pre_positioning_triggered: boolean
  pre_positioning_blocked: boolean
  proactive_outreach_queued: boolean
  signal_timestamp: string
  ingested?: boolean
}

export interface IoTEstateHealth {
  connected_devices: number
  boiler_signals_live: number
  smart_meters_reporting: number
  vans_reporting: number
  vans_total: number
  van_telemetry_health_pct: number | null
  parts_cover_pct: number | null
  actionable_signals: number
  pre_positioning_blocked: number
  commissioning_failures_7d: number
}

export interface SmartMeterStatus {
  installed_total: number
  dcc_registered: number
  firmware_updated: number
  commissioning_failures_7d: number
  install_rate_per_week: number | null
  target_fy: number
}

export interface PredictiveReplacement {
  device_id: string
  property_postcode: string
  boiler_brand: string
  boiler_age_years: number
  replacement_probability_90d: number
  recommended_replacement_unit: string
  outreach_queued: boolean
  estimated_job_date: string
}

export async function fetchBoilerFaultPipeline(): Promise<BoilerFaultSignal[]> {
  const res = await api.get('/api/v1/iot/fault-pipeline')
  return res.data.data
}

export async function fetchIoTEstateHealth(): Promise<IoTEstateHealth> {
  const res = await api.get('/api/v1/iot/estate-health')
  return res.data.data
}

export async function fetchSmartMeterStatus(): Promise<SmartMeterStatus> {
  const res = await api.get('/api/v1/iot/smart-meter-status')
  return res.data.data
}

export async function fetchPredictiveReplacements(): Promise<PredictiveReplacement[]> {
  const res = await api.get('/api/v1/iot/predictive-replacements')
  return res.data.data
}

export async function fetchSustainabilityDashboard() {
  const res = await api.get('/api/v1/reverse/sustainability-dashboard')
  return res.data.data
}

export async function fetchLabourAssessment() {
  const res = await api.get('/api/v1/risk/labour-assessment')
  return res.data.data
}

export async function fetchLabourHistory(warehouseCode: string) {
  const res = await api.get(`/api/v1/risk/labour-assessment/${warehouseCode}/history`)
  return res.data.data
}

// Full scorecard for one supplier, including 12-week OTIF history.
export async function fetchSupplierScorecard(supplierCode: string) {
  const res = await api.get(`/api/v1/risk/suppliers/${supplierCode}/scorecard`)
  return res.data.data
}

export async function fetchInboundShipments(status?: string) {
  const params = status ? `?status=${status}` : ''
  const res = await api.get(`/api/v1/visibility/inbound-shipments${params}`)
  return res.data.data
}

// Full scenario/risk-plan registry — used to look up the AI Risk Plan for an
// exception (by exc.scenario_id) and by the Scenario Simulator for scenario
// names/affected modules.
export async function fetchRiskPlans() {
  const res = await api.get('/api/v1/demo/scenarios')
  return res.data.data
}

export async function acknowledgeException(code: string, by: string, notes?: string) {
  const res = await api.post(`/api/v1/exceptions/${code}/acknowledge`, { acknowledged_by: by, notes })
  return res.data.data
}

export async function resolveException(code: string, by: string, rootCause: string, notes?: string) {
  const res = await api.post(`/api/v1/exceptions/${code}/resolve`, {
    resolved_by: by, root_cause: rootCause, resolution_notes: notes,
  })
  return res.data.data
}

export async function activateRiskPlan(code: string, by: string) {
  const res = await api.post(`/api/v1/exceptions/${code}/activate-plan`, { activated_by: by })
  return res.data.data
}

export async function fetchActiveScenario() {
  const res = await api.get('/api/v1/demo/active-scenario')
  return res.data.data
}

export async function fetchFleetSummary() {
  const res = await api.get('/api/v1/transport/summary')
  return res.data.data
}

export async function fetchFleet(status?: string, search?: string) {
  const params = new URLSearchParams()
  if (status && status !== 'all') params.set('status', status)
  if (search) params.set('search', search)
  const res = await api.get(`/api/v1/transport/fleet?${params}`)
  return res.data.data
}

export async function fetchCazZones() {
  const res = await api.get('/api/v1/transport/caz-zones')
  return res.data.data
}

export async function fetchRouteOptimization() {
  const res = await api.get('/api/v1/transport/route-optimization')
  return res.data.data
}

/**
 * Re-run the optimiser against where the van actually is, what is actually left
 * on the round, and the traffic that is actually on the road right now — as
 * opposed to the day-plan result computed at first light.
 *
 * Returns the full derivation: baseline sequence, optimised sequence, the
 * per-factor money delta and the binding constraints. Pass `apply` to commit the
 * new sequence to the live round rather than previewing it.
 */
export async function optimizeEngineerRoute(engineerCode: string, apply = false) {
  const res = await api.post(
    `/api/v1/transport/routes/${engineerCode}/optimize?apply=${apply}`)
  return res.data.data
}

/**
 * The factors the optimiser weighs and what each is priced at — published so a
 * scheduling decision can be interrogated rather than merely trusted.
 */
export async function fetchOptimizationModel() {
  const res = await api.get('/api/v1/transport/route-optimization/model')
  return res.data.data
}

// What ATLAS and the operators have actually done today, grouped by module and
// by the section of that module the action belongs to. Read off the same audit
// trail the Audit Log renders, so a count and the entries behind it agree.
export interface ActionsTodayBucket {
  actions: number
  auto: number
  approved: number
  operator: number
  latest_at: string | null
}
export interface ActionsTodayModule extends ActionsTodayBucket {
  module: string
  module_label: string
  sections: Record<string, ActionsTodayBucket & { section: string }>
}
export interface ActionsToday {
  date: string
  total: ActionsTodayBucket
  modules: Record<string, ActionsTodayModule>
  generated_at: string
}

export async function fetchActionsToday(): Promise<ActionsToday> {
  const res = await api.get('/api/v1/agents/actions-today')
  return res.data.data
}

export async function fetchEngineerRoute(engineerCode: string) {
  const res = await api.get(`/api/v1/transport/routes/${engineerCode}`)
  return res.data.data
}

export async function completeWalkaround(registration: string, completedBy: string) {
  const res = await api.post(`/api/v1/transport/vehicles/${registration}/walkaround`, { completed_by: completedBy })
  return res.data.data
}

export async function resolveVehicleDefect(registration: string, defectId: string, resolvedBy: string) {
  const res = await api.put(`/api/v1/transport/vehicles/${registration}/defects/${defectId}/resolve`, { resolved_by: resolvedBy })
  return res.data.data
}

// ── Operational resolution layer ─────────────────────────────────────────────
// Four alert families, each row carrying the courses of action available for it
// priced against live state. Applying one mutates the network for real: stock
// moves, a route gains a stop, a carrier leg is re-booked, an order is posted.

export interface ResolutionOption {
  action: string
  label: string
  blurb: string
  detail: string
  available: boolean
  unavailable_reason: string | null
  eta_mins: number | null
  cost_gbp: number
  sla_impact: string
  confidence: number
  recommended: boolean
  autonomy: 'auto' | 'human'
  consequence?: string
  [k: string]: any
}

export async function fetchVanAlerts(params: { region?: string; severity?: string } = {}) {
  const p = new URLSearchParams()
  if (params.region) p.set('region', params.region)
  if (params.severity && params.severity !== 'all') p.set('severity', params.severity)
  const res = await api.get(`/api/v1/visibility/van-alerts?${p}`)
  return res.data.data
}

export async function resolveVanAlert(engineerCode: string, action: string, by: string, extra?: Record<string, any>) {
  const res = await api.post(`/api/v1/visibility/van-alerts/${engineerCode}/resolve`, { action, by, params: extra })
  return res.data.data
}

export async function fetchLockerMisses(region?: string) {
  const p = region ? `?region=${encodeURIComponent(region)}` : ''
  const res = await api.get(`/api/v1/visibility/locker-misses${p}`)
  return res.data.data
}

export async function resolveLockerMiss(siteCode: string, action: string, by: string, extra?: Record<string, any>) {
  const res = await api.post(`/api/v1/visibility/locker-misses/${siteCode}/resolve`, { action, by, params: extra })
  return res.data.data
}

export async function fetchCarrierMovements(params: { status?: string; dest_type?: string } = {}) {
  const p = new URLSearchParams()
  if (params.status && params.status !== 'all') p.set('status', params.status)
  if (params.dest_type && params.dest_type !== 'all') p.set('dest_type', params.dest_type)
  const res = await api.get(`/api/v1/transport/carrier-movements?${p}`)
  return res.data.data
}

export async function resolveCarrierMovement(movementRef: string, action: string, by: string, extra?: Record<string, any>) {
  const res = await api.post(`/api/v1/transport/carrier-movements/${movementRef}/resolve`, { action, by, params: extra })
  return res.data.data
}

export async function fetchEtaRisk(region?: string) {
  const p = region ? `?region=${encodeURIComponent(region)}` : ''
  const res = await api.get(`/api/v1/transport/eta-risk${p}`)
  return res.data.data
}

export async function resolveEtaRisk(engineerCode: string, action: string, by: string, extra?: Record<string, any>) {
  const res = await api.post(`/api/v1/transport/eta-risk/${engineerCode}/resolve`, { action, by, params: extra })
  return res.data.data
}

/**
 * Today's jobs whose SLA is in jeopardy, split by cause.
 *
 * Served from `analytics` rather than from `visibility` or `transport` because it is
 * the UNION of a Field Operations failure (van short of the part) and a Transport
 * Control one (van will not arrive in time). The two sets overlap, so the union has
 * to be taken over job codes server-side — the Executive Dashboard, the Live
 * Visibility Hub and Transport Control all read this one answer instead of three
 * client-side sums that would disagree.
 */
export async function fetchJobsAtRisk(region?: string) {
  const p = region ? `?region=${encodeURIComponent(region)}` : ''
  const res = await api.get(`/api/v1/analytics/jobs-at-risk${p}`)
  return res.data.data
}

// The per-family update cadence the state engine is running, plus any entity
// currently pinned against redraw because somebody acted on it.
export async function fetchStateEngine() {
  const res = await api.get('/api/v1/transport/state-engine')
  return res.data.data
}

// ── Agentic AI layer ─────────────────────────────────────────────────────────
// Specialist agents sense live state, reason, and PROPOSE actions; at
// semi-autonomy every action is gated behind a human approval that executes the
// real underlying mutation (PO, transfer, plan activation, acknowledge).

export async function fetchAgentFleet() {
  const res = await api.get('/api/v1/agents')
  return res.data.data
}

export async function fetchAgentRecommendations(agentId?: string) {
  const p = agentId && agentId !== 'orchestrator' ? `?agent_id=${agentId}` : ''
  const res = await api.get(`/api/v1/agents/recommendations${p}`)
  return res.data.data
}

export async function fetchAgentActivity(limit = 40) {
  const res = await api.get(`/api/v1/agents/activity?limit=${limit}`)
  return res.data.data
}

export async function approveRecommendation(recId: string) {
  const res = await api.post(`/api/v1/agents/recommendations/${recId}/approve`)
  return res.data.data
}

export async function dismissRecommendation(recId: string, reason?: string) {
  const res = await api.post(`/api/v1/agents/recommendations/${recId}/dismiss`, { reason })
  return res.data.data
}

export async function setAgentAutonomy(agentId: string, level: 'manual' | 'semi' | 'auto') {
  const res = await api.put(`/api/v1/agents/${agentId}/autonomy`, { level })
  return res.data.data
}

// The master switch, server-side. Flipping it re-applies the current state through
// the other variation (AI-OFF = raw disruption, AI-ON = ~80% worked autonomously),
// so every module reflects the change — it is not a UI-only toggle.
export async function setAiEnabled(enabled: boolean) {
  const res = await api.put('/api/v1/agents/mode', { enabled })
  return res.data.data
}

// The full action catalog: every action a user can perform in every module/tab,
// what ATLAS may do autonomously, and exactly when a human must decide.
export async function fetchGovernance() {
  const res = await api.get('/api/v1/agents/governance')
  return res.data.data
}

// What ATLAS did to the state currently applied — executed vs escalated, with
// the health it moved the network from and to.
export async function fetchStateVariation() {
  const res = await api.get('/api/v1/agents/state-variation')
  return res.data.data
}

// ── Ask ATLAS ────────────────────────────────────────────────────────────────
// A conversation over the whole live state, with hands: ATLAS reads any section
// of state it needs, and when asked to DO something it runs the action outright
// if policy allows it, or hands back a proposal for this operator to approve.

export interface AtlasTurn { role: 'user' | 'model'; text: string }

export interface AtlasStep {
  kind: 'read' | 'action' | 'proposal' | 'failed'
  tool: string
  label: string
  detail?: string
}

export interface AtlasGovernance {
  class?: 'observe' | 'auto' | 'human' | 'dual'
  label?: string
  module_label?: string
  tab?: string
  permission?: string
  reversibility?: string
  blast_radius?: string
  commits_spend?: boolean
  why_human?: string
  approval_trigger?: string
  dual_control?: boolean
  reason?: string
  blocked?: boolean
  auto?: boolean
  value_gbp?: number
}

export interface AtlasAction {
  id: string
  label: string
  summary?: string
  executes?: string
  governance: AtlasGovernance
  value_gbp?: number
  severity?: string
  confidence?: number
  status?: string
}

export interface AtlasReply {
  answer: string
  source: 'gemini' | 'rules'
  model: string | null
  steps: AtlasStep[]
  executed: AtlasAction[]
  proposals: AtlasAction[]
  suggestions: string[]
  state_stamp: {
    health?: string; pending_approvals?: number; open_exceptions?: number
    ai_mode?: boolean; as_of?: string
  }
  at: string
  conversation_id?: string
  title?: string
}

export async function askAtlas(question: string, history: AtlasTurn[] = [], conversationId?: string | null): Promise<AtlasReply> {
  const res = await api.post('/api/v1/agents/ask',
    { question, history, conversation_id: conversationId ?? null }, { timeout: 90_000 })
  return res.data.data
}

// ── Voice ────────────────────────────────────────────────────────────────────
// Audio bookends the ordinary text turn: speech becomes a question, the normal
// grounded pipeline answers it, and the answer is read back. The response on
// screen is unchanged — the spoken version is rewritten for the ear server-side.

export async function transcribeAudio(base64Wav: string, mimeType = 'audio/wav'): Promise<string> {
  const res = await api.post('/api/v1/agents/ask/transcribe',
    { audio: base64Wav, mime_type: mimeType }, { timeout: 60_000 })
  return res.data.data.text
}

export async function speakAnswer(
  text: string,
  opts: { executed?: AtlasAction[]; proposals?: AtlasAction[]; voice?: string } = {},
): Promise<Blob> {
  const res = await api.post('/api/v1/agents/ask/speak',
    { text, executed: opts.executed ?? [], proposals: opts.proposals ?? [], voice: opts.voice ?? 'Kore' },
    { responseType: 'blob', timeout: 120_000 })
  return res.data as Blob
}

// ── Conversation history (server-side, Redis-backed) ─────────────────────────
// A control-tower conversation is a record of what was asked during an incident
// and what was done about it, so it outlives the tab it was typed in.

export interface AtlasConversation {
  id: string
  title: string
  created_at: string
  updated_at: string
  message_count: number
  preview: string
  actions: number
  proposals: number
}

// ── Reasoning model ──────────────────────────────────────────────────────────
// Which model ATLAS thinks with, across both providers the backend can reach:
// Google AI Studio direct, and OpenRouter for everything else. Only models whose
// key is configured are ever returned. Switching is a runtime choice, applies to
// the next question, and is remembered across restarts.

export type AtlasProvider = 'google' | 'openrouter'

export interface AtlasModel {
  id: string
  label: string
  blurb: string
  active: boolean
  provider: AtlasProvider
  provider_label: string
}

export async function fetchAtlasModels() {
  const res = await api.get('/api/v1/agents/models')
  return res.data.data as {
    models: AtlasModel[]; active: string; enabled: boolean
    provider: AtlasProvider | null
    providers: { id: AtlasProvider; label: string; configured: boolean }[]
  }
}

export async function setAtlasModel(modelId: string) {
  const res = await api.put('/api/v1/agents/model', { model_id: modelId })
  return res.data.data as { models: AtlasModel[]; active: AtlasModel }
}

export async function fetchAtlasConversations(limit = 30): Promise<AtlasConversation[]> {
  const res = await api.get(`/api/v1/agents/ask/conversations?limit=${limit}`)
  return res.data.data.conversations
}

export async function fetchAtlasConversation(id: string) {
  const res = await api.get(`/api/v1/agents/ask/conversations/${id}`)
  return res.data.data as {
    id: string; title: string; created_at: string; updated_at: string
    messages: any[]
    proposal_states: Record<string, { status: string; summary?: string }>
  }
}

export async function deleteAtlasConversation(id: string) {
  const res = await api.delete(`/api/v1/agents/ask/conversations/${id}`)
  return res.data.data
}

export async function clearAtlasConversations() {
  const res = await api.delete('/api/v1/agents/ask/conversations')
  return res.data.data
}

export async function decideAtlasProposal(proposalId: string, decision: 'approve' | 'decline', reason?: string) {
  const res = await api.post(`/api/v1/agents/ask/proposals/${proposalId}`, { decision, reason })
  return res.data.data
}

export async function updateGuardrails(patch: {
  auto_approve_under_gbp?: number; spend_ceiling_gbp?: number; requires_dual_control_over_gbp?: number
}) {
  const res = await api.put('/api/v1/agents/guardrails', patch)
  return res.data.data
}

export async function createWatchRule(rule: {
  name?: string; metric: string; operator: string; threshold: number; severity?: string
}) {
  const res = await api.post('/api/v1/agents/rules', rule)
  return res.data.data
}

export async function deleteWatchRule(ruleId: string) {
  const res = await api.delete(`/api/v1/agents/rules/${ruleId}`)
  return res.data.data
}

export async function login(email: string, password: string) {
  const res = await api.post('/api/v1/auth/login', { email, password })
  return res.data
}

export async function fetchDemoUsers() {
  const res = await api.get('/api/v1/auth/demo-users')
  return res.data
}
