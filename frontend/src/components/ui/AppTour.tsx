import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../../store/useStore'
import { usePermissions } from '../../hooks/usePermissions'
import {
  X, ChevronLeft, ChevronRight, ArrowRight, Compass, Check, MousePointerClick,
  LayoutDashboard, Map, Truck, Package, Leaf, AlertTriangle, Clapperboard,
  ShieldCheck, Sparkles, PlayCircle, Layers,
} from 'lucide-react'

// ═══════════════════════════════════════════════════════════════════════════
// In-app tour.
//
// Three surfaces, not one long walkthrough:
//
//   1. WELCOME   a short card on first sign-in offering a two-minute
//                orientation — an invitation, never a forced march.
//   2. HUB       a checklist of short tours, one per module, with progress.
//                Completion is remembered, so a user picks up the module they
//                need on the day they need it.
//   3. RUNNER    the tour itself: spotlight plus a compact card of one or two
//                sentences, driving the real product.
//
// Two decisions carry the design:
//
//   SHORT. Each tour is four to six steps. Completion collapses with length —
//   a three-step tour finishes around 72% of the time, a seven-step one nearer
//   16% — so a module's tour has to end while the user is still in it. Users
//   who want everything turn on Detailed mode in the hub, which appends the
//   deeper steps to every tour.
//
//   ONE OUTCOME PER TOUR, NOT PER STEP. What a feature is worth is a claim
//   about the module, and repeating it on every card turns it into wallpaper.
//   It is stated once on the hub card and once more on the closing step, where
//   it lands as a payoff instead of a tax on each click.
//
// Steps marked `act` hand control back: the spotlight becomes clickable, the
// page underneath stays inert, and the user performs the action themselves.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Storage ──────────────────────────────────────────────────────────────────

const SESSION_KEY = 'clt_tour_seen'
const optOutKey = (email: string) => `clt_tour_optout:${email}`
const doneKey = (email: string) => `clt_tour_done:${email}`
const detailKey = (email: string) => `clt_tour_detail:${email}`

/** True on a fresh sign-in or a new tab, unless this user turned the prompt off. */
export function shouldAutoShowTour(email: string | undefined | null): boolean {
  if (!email) return false
  if (sessionStorage.getItem(SESSION_KEY)) return false
  if (localStorage.getItem(optOutKey(email))) return false
  return true
}

export function markTourSessionSeen() {
  sessionStorage.setItem(SESSION_KEY, '1')
}

function readDone(email?: string): string[] {
  if (!email) return []
  try {
    const raw = localStorage.getItem(doneKey(email))
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

// ─── Script model ─────────────────────────────────────────────────────────────

interface StepAction {
  click: string
  skipIf?: string
  timeout?: number
  wait?: number
}

interface Step {
  /** Card heading — the feature's name. */
  title: string
  /** One or two sentences. Anything longer stops being read. */
  body: string
  /** CSS selector to spotlight. Omitted = a centred card. */
  target?: string
  /** Route override; the tour's route is used otherwise. */
  route?: string
  /** Clicks performed before the spotlight lands. */
  actions?: StepAction[]
  /**
   * Turns the step into a do-it-yourself one: the spotlight becomes clickable
   * and the tour waits for the user to click the target. The string is the
   * prompt ("Open Van Alerts").
   */
  act?: string
  /** Page permission this step needs — it is dropped for roles without it. */
  needs?: string
}

interface Tour {
  id: string
  title: string
  icon: React.ElementType
  route?: string
  permRoute?: string
  when?: (ctx: { aiMode: boolean }) => boolean
  /** One line on the hub card — what the module is for. */
  blurb: string
  /** What the module is worth. Shown on the hub card and the closing step. */
  outcome: string
  /** The measures it moves. */
  moves: string[]
  /** The essential path — four to six steps. */
  steps: Step[]
  /** Appended in Detailed mode, for users who want every panel. */
  more?: Step[]
}

const at = (key: string) => `[data-tour="${key}"]`

const TOURS: Tour[] = [

  // ── Orientation ─────────────────────────────────────────────────────────────
  {
    id: 'start',
    title: 'Getting oriented',
    icon: Compass,
    blurb: 'How the tower is laid out and the conventions used on every screen.',
    outcome:
      'One console instead of four systems and a morning ring-round. Problems surface in seconds rather than at the 10am stand-up.',
    moves: ['Time to detect', 'Onboarding time'],
    steps: [
      {
        title: 'Everything lives in this rail',
        body: 'Grouped Overview, Operations and Risk Management. You only see the modules your role can open.',
        target: '.sidebar',
      },
      {
        title: 'Every page states its data age',
        body: 'LIVE means updates are pushed the moment they happen. POLLING means a 60-second refresh. You never reload.',
        target: '.page-header',
      },
      {
        title: 'Numbers explain themselves',
        body: 'Hover any metric for its definition, calculation and target. Click it to open the module that owns it.',
        target: at('dash-scorecard'),
        route: '/',
        needs: '/',
      },
      {
        title: 'Theme, support and this tour',
        body: 'The footer flips light and dark, raises a hand to the team, and reopens the tour hub whenever you want it.',
        target: '.sidebar-footer',
      },
    ],
    more: [
      {
        title: 'Critical incidents find you',
        body: 'A P1 anywhere in the network raises a red banner across every page and a badge on the Exceptions rail item.',
        target: '.sidebar',
      },
    ],
  },

  // ── Executive Dashboard ─────────────────────────────────────────────────────
  {
    id: 'dashboard',
    title: 'Executive Dashboard',
    icon: LayoutDashboard,
    route: '/',
    blurb: 'The whole operation on one screen: status, north-star KPIs, a panel per module.',
    outcome:
      'Answers "are we healthy?" in ten seconds and "where exactly is the problem?" in one click — so leadership time goes into the decision, not into assembling the picture.',
    moves: ['Time to detect', 'Reporting effort'],
    steps: [
      {
        title: 'Operations status',
        body: 'The network\'s verdict, then a chip per open exception priority. Every chip opens the queue behind it.',
        target: at('dash-status'),
      },
      {
        title: 'Network Scorecard',
        body: 'First-time fix plus the leading measure of every module, each against its target with a trend.',
        target: at('dash-scorecard'),
      },
      {
        title: 'A panel per module',
        body: 'Every tracked KPI grouped under the module that owns it, so each number has exactly one home.',
        target: at('dash-modules'),
      },
      {
        title: 'Today first, then the averages',
        body: 'Each panel leads with what can still be changed today — here, the jobs with no part in the van.',
        target: at('dash-mod-field'),
      },
      {
        title: 'Straight through to the work',
        body: 'The health verdict sits top right and Open takes you into the module already in context.',
        target: at('dash-mod-transport'),
      },
    ],
    more: [
      {
        title: 'Demand & Inventory',
        body: 'Availability and working capital side by side — fill rate, days of supply, turns, GMROI and capital tied up.',
        target: at('dash-mod-demand'),
      },
      {
        title: '3PL & Warehouse',
        body: 'Network capacity against baseline with a chart per site. Below 40% is a P1-level disruption.',
        target: at('dash-mod-3pl'),
      },
      {
        title: 'Supplier & Procurement Risk',
        body: 'Volume-weighted OTIF, Ariba contract expiries, and the emergency PO rate — the price of supplier drift.',
        target: at('dash-mod-supplier'),
      },
      {
        title: 'Sustainability',
        body: 'Circularity, carbon against target, and the value recovered by reconditioning instead of buying new.',
        target: at('dash-mod-sustainability'),
      },
    ],
  },

  // ── Live Field Ops ──────────────────────────────────────────────────────────
  {
    id: 'visibility',
    title: 'Live Field Ops',
    icon: Map,
    route: '/visibility',
    blurb: 'The dispatcher\'s room: live map, jobs in jeopardy, van stock and lockers.',
    outcome:
      'Catches the failed visit before the engineer sets off. A prevented truck roll saves the visit cost, the customer credit and tomorrow\'s slot.',
    moves: ['First Time Fix Rate', 'Truck rolls', 'Pre-8AM delivery'],
    steps: [
      {
        title: 'The live pulse',
        body: 'Engineers by status, van alerts, locker alerts and hub throughput — always on screen while you work.',
        target: at('vis-statusbar'),
      },
      {
        title: 'The field force, live',
        body: 'Green available, blue driving, amber on site. A red ring means that van is below minimum on a job-critical part.',
        target: '.leaflet-container',
      },
      {
        title: 'Jobs at SLA risk today',
        body: 'The appointments projected to miss, split by cause — because a late round is re-sequenced and an empty van is restocked.',
        target: at('vis-jobs-risk'),
        actions: [{ click: '#visibility-tab-overview' }],
      },
      {
        title: 'Open Van Alerts',
        body: 'The queue for vans below minimum sits behind this tab.',
        target: '#visibility-tab-van_alerts',
        act: 'Click Van Alerts',
      },
      {
        title: 'Alerts that arrive with the fix',
        body: 'Each van ranked by the jobs it puts at risk, with priced options: transfer from a nearby van, reallocate, collect en route, or replenish tonight.',
        target: '#visibility-panel-van_alerts',
      },
      {
        title: 'The overnight wave',
        body: 'Lockers shows every pre-8AM miss with its cause, and only the recoveries that cause allows.',
        target: '#visibility-panel-lockers',
        actions: [{ click: '#visibility-tab-lockers' }],
      },
    ],
    more: [
      {
        title: 'Layers and filters',
        body: 'Toggle engineers, lockers and hubs, then filter the field force down to the handful a decision involves.',
        target: at('vis-layers'),
      },
      {
        title: 'Field force counts',
        body: 'Available, en route, on site and van alerts — the four numbers checked before any job is assigned.',
        target: at('vis-field-force'),
        actions: [{ click: '#visibility-tab-overview' }],
      },
      {
        title: 'Action queues',
        body: 'The two alert families that carry their own resolutions. When a queue is clear it says so, in green.',
        target: at('vis-queues'),
      },
      {
        title: 'Field KPIs against target',
        body: 'First-time fix, pre-8AM delivery, in-boot availability and expediting cost, each with a health bar.',
        target: at('vis-kpis'),
      },
      {
        title: 'Warehouse throughput',
        body: 'Every hub\'s output as a share of normal, directly under the field KPIs it feeds.',
        target: at('vis-throughput'),
      },
      {
        title: 'The engineer file',
        body: 'Search by name or business unit, then open anyone for their live status and van stock line by line.',
        target: '#visibility-panel-engineers',
        actions: [{ click: '#visibility-tab-engineers' }],
      },
      {
        title: 'Hub detail',
        body: 'Throughput against baseline, a 24-hour trend, courier on-time rate, staffing and labour risk.',
        target: '#visibility-panel-warehouses',
        actions: [{ click: '#visibility-tab-warehouses' }],
      },
    ],
  },

  // ── Transport Control ───────────────────────────────────────────────────────
  {
    id: 'transport',
    title: 'Transport Control',
    icon: Truck,
    route: '/transport',
    blurb: 'The van fleet: where it is, whether it is legal, and whether it will arrive.',
    outcome:
      'Late arrivals get caught while there is still road left to make up, and roadworthiness becomes a ten-minute morning task instead of an enforcement finding.',
    moves: ['On-time delivery', 'DVSA compliance', 'VOR days'],
    steps: [
      {
        title: 'The fleet, live',
        body: 'A red ring is a van off road or carrying an open defect. Purple circles are Clean Air Zones, where older vans pay to enter.',
        target: '.leaflet-container',
      },
      {
        title: 'Open Compliance',
        body: 'The daily legal checklist lives behind this tab.',
        target: '#transport-tab-compliance',
        act: 'Click Compliance',
      },
      {
        title: 'Legal to drive, today',
        body: 'Missing DVSA walkaround checks, open defects by severity, and MOTs falling due within 30 days.',
        target: '#transport-panel-compliance',
      },
      {
        title: 'Arrival risk before optimisation',
        body: 'Routes leads with the rounds projected to miss a window, and six ways to recover each one.',
        target: '#transport-panel-routes',
        actions: [{ click: '#transport-tab-routes' }],
      },
      {
        title: 'Third-party legs',
        body: 'Carriers tracks every locker, in-boot and two-man delivery milestone by milestone, with recovery options on the late ones.',
        target: '#transport-panel-carriers',
        actions: [{ click: '#transport-tab-carriers' }],
      },
    ],
    more: [
      {
        title: 'Fleet status strip',
        body: 'Vans active and off road, engineers running late, carrier delays and the average driver score.',
        target: at('tr-statusbar'),
      },
      {
        title: 'Overview tiles',
        body: 'Every tile opens the tab that owns it, already filtered — including the drivers scoring below 70 for coaching.',
        target: '#transport-panel-overview',
        actions: [{ click: '#transport-tab-overview' }],
      },
      {
        title: 'The vehicle file',
        body: 'Today\'s route stop by stop, walkaround status, defects, servicing, seven days of telematics and running costs.',
        target: '#transport-panel-vehicles',
        actions: [{ click: '#transport-tab-vehicles' }],
      },
    ],
  },

  // ── Demand & Inventory ──────────────────────────────────────────────────────
  {
    id: 'demand',
    title: 'Demand & Inventory',
    icon: Package,
    route: '/demand',
    blurb: 'Position the stock, execute replenishment, orchestrate the horizon.',
    outcome:
      'A £30 valve that is missing costs a failed visit, an emergency courier and an SLA penalty. This is where that gets prevented — and where excess capital comes out without service going with it.',
    moves: ['Fill rate', 'Working capital', 'Emergency PO %'],
    steps: [
      {
        title: 'Scope the whole page',
        body: 'The network, the Leicester NDC, or one regional hub. A site carrying at-risk SKUs shows its count on the pill.',
        target: at('dem-scope'),
      },
      {
        title: 'Availability at a glance',
        body: 'Fill rate falls before anything actually runs out — that gap is the window you get to act in.',
        target: at('dem-kpis'),
      },
      {
        title: 'How stock actually moves',
        body: 'Suppliers deliver into the NDC; trunker transfers feed the hubs. A red hub with a green NDC is a transfer, not a purchase order.',
        target: at('dem-flow'),
      },
      {
        title: 'Open the Planner Worklist',
        body: 'The module\'s single queue of open actions.',
        target: at('dem-tab-worklist'),
        act: 'Click Planner Worklist',
      },
      {
        title: 'Ranked by money at risk',
        body: 'Every open action with an owner, an SLA and a one-click fix. Work top-down and the largest exposure is always handled first.',
        target: at('dem-worklist'),
      },
      {
        title: 'Down to the SKU',
        body: 'Per-site health for every part. Click a row for its 30-day projection, the stockout day, and what-if sliders on demand and supply.',
        target: at('dem-positions'),
        actions: [{ click: at('dem-tab-position') }],
      },
    ],
    more: [
      {
        title: 'State of the network',
        body: 'Working capital, value at risk, excess capital and GMROI — the finance view of the same stock.',
        target: at('dem-network-band'),
      },
      {
        title: 'ABC/XYZ segmentation',
        body: 'Nine cells by annual value and demand predictability, each with its own service target sizing its safety stock.',
        target: at('dem-segmentation'),
        actions: [{ click: at('dem-tab-position') }],
      },
      {
        title: 'Multi-echelon optimisation',
        body: 'Site-by-site buffers against echelon-aware ones. The gap is duplicated safety stock, priced in pounds.',
        target: at('dem-meio'),
      },
      {
        title: 'Forecast quality',
        body: 'MAPE, bias and forecast value added. Bias matters more: it is a recurring stockout or idle capital, not noise.',
        target: at('dem-health'),
      },
      {
        title: 'Replenishment routing',
        body: 'NDC shortfalls are filled by a supplier PO, hub shortfalls by a stock transport order. One rule, so the engines never double-order.',
        target: at('dem-routing'),
        actions: [{ click: at('dem-tab-execute') }],
      },
      {
        title: 'Purchase orders',
        body: 'Standard, emergency and Auto-raised orders inbound to the NDC. Emergency ones always wait for a human.',
        target: at('dem-po'),
      },
      {
        title: 'Stock transport orders',
        body: 'The internal queue: stock that already exists, moved rather than bought.',
        target: at('dem-sto'),
      },
      {
        title: 'S&OP and allocation',
        body: 'Six months of demand against supply capability. Red months are supply-constrained.',
        target: at('dem-sop'),
        actions: [{ click: at('dem-tab-orchestrate') }],
      },
      {
        title: 'The network twin',
        body: 'Rehearse a demand shock or a supply slip at network scale and see the recovery priced before committing to it.',
        target: at('dem-twin'),
      },
      {
        title: 'Programme drivers',
        body: 'Grants, the service book and rollout programmes — the medium-term volume that feeds S&OP.',
        target: at('dem-programmes'),
        actions: [{ click: at('dem-tab-programmes') }],
      },
    ],
  },

  // ── Exceptions ──────────────────────────────────────────────────────────────
  {
    id: 'exceptions',
    title: 'Exception Management',
    icon: AlertTriangle,
    route: '/exceptions',
    blurb: 'The alarm centre: every abnormality, prioritised, owned and closed.',
    outcome:
      'The target is a first response to a P1 inside five minutes. Ownership with a timestamp is what makes that measurable at all, and a recorded root cause is what stops the same incident recurring.',
    moves: ['P1 response time', 'Mean time to resolve'],
    steps: [
      {
        title: 'The alarm summary',
        body: 'Open P1s, open P2s, everything open, and how many arrive with an AI risk plan already attached.',
        target: at('exc-summary'),
      },
      {
        title: 'Open the top exception',
        body: 'The queue is worst-first, and impact sits on the row so triage happens in the list.',
        target: at('exc-row'),
        // Only the spotlighted row is reachable through the blocker, so the
        // prompt names that row rather than inviting a click anywhere.
        act: 'Click the top row',
      },
      {
        title: 'Impact, then the timeline',
        body: 'Engineers at risk, estimated resolution time, and a recurrence count that flags repeat offenders.',
        target: at('exc-detail'),
      },
      {
        title: 'Acknowledge, then resolve',
        body: 'Recognised scenarios come with an AI risk plan — activating it fires real compensating actions across the network.',
        target: at('exc-detail'),
      },
    ],
    more: [
      {
        title: 'Priority and status filters',
        body: 'The counts on each button show where the workload sits, so forty P4s cannot hide one P2.',
        target: at('exc-filters'),
      },
      {
        title: 'The queue itself',
        body: 'Worst first, with priority, category and engineers impacted on the row — the field that breaks a tie between two P2s.',
        target: at('exc-list'),
      },
    ],
  },

  // ── Scenario Simulator ──────────────────────────────────────────────────────
  {
    id: 'simulator',
    title: 'Scenario Simulator',
    icon: Clapperboard,
    route: '/simulator',
    blurb: 'Inject a real disruption, watch every module react, reset in one click.',
    outcome:
      'A continuity plan that has never been run is an assumption. Rehearse one end to end — disruption, exception, AI plan, reset — without risking a real day.',
    moves: ['Continuity readiness', 'Mean time to resolve'],
    steps: [
      {
        title: 'One definition of critical',
        body: 'Healthy, At Risk and Critical spelled out, so the colours mean the same thing on every desk.',
        target: at('sim-health'),
      },
      {
        title: 'What state you are in',
        body: 'The banner names the baseline or the live scenario, so a rehearsal is never mistaken for a real incident.',
        target: at('sim-state'),
      },
      {
        title: 'Routine risks',
        body: 'A locker outage, a courier no-show, a supplier slipping — the friction a tower absorbs most weeks.',
        target: at('sim-routine'),
      },
      {
        title: 'Major events',
        body: 'Eight heavyweight scenarios from a 3PL closure to a national fuel crisis. Each card lists the modules it will hit.',
        target: at('sim-major'),
      },
    ],
  },

  // ── Supplier & Labour Risk ──────────────────────────────────────────────────
  {
    id: 'risk',
    title: 'Supplier & Labour Risk',
    icon: ShieldCheck,
    route: '/risk',
    blurb: 'The partners you depend on but do not control.',
    outcome:
      'Suppliers and warehouse labour both degrade gradually and both stop the chain. This turns that into weeks of warning instead of a Monday-morning surprise.',
    moves: ['Supplier OTIF', 'Supply continuity'],
    steps: [
      {
        title: 'The supply base in four numbers',
        body: 'OTIF is volume-weighted: one large supplier at 78% matters more than five small ones at 99%.',
        target: at('risk-kpis'),
        actions: [{ click: at('risk-tab-suppliers'), wait: 400 }],
      },
      {
        title: 'Where the concentration risk is',
        body: 'Order volume across, delivery reliability up. A big bubble low on the chart is your real exposure.',
        target: at('risk-matrix'),
      },
      {
        title: 'Suppliers with live risk drivers',
        body: 'OTIF slippage, expiring Ariba contracts, financial red flags and ethical audit findings, worst first.',
        target: at('risk-watchlist'),
      },
      {
        title: 'Open the Labour tab',
        body: 'The other half of the module watches the 3PL warehouse workforce.',
        target: at('risk-tab-labour'),
        act: 'Click Labour Risk',
      },
      {
        title: 'Every site scored 0–100',
        body: 'Absenteeism, turnover, agency dependency and overtime strain. Green under 30; 60 or more is red.',
        target: at('risk-labour-sites'),
      },
    ],
    more: [
      {
        title: 'Supplier scorecards',
        body: 'OTIF against target plus a composite score blending delivery, finance, geopolitics, Sedex and contract compliance.',
        target: at('risk-scorecards'),
        actions: [{ click: at('risk-tab-suppliers'), wait: 400 }],
      },
      {
        title: 'Early-warning signals',
        body: 'Union activity, news mentions and the industrial-action stage — weeks of notice before a site cannot run a shift.',
        target: at('risk-labour-watchlist'),
        actions: [{ click: at('risk-tab-labour'), wait: 400 }],
      },
    ],
  },

  // ── Sustainability ──────────────────────────────────────────────────────────
  {
    id: 'sustainability',
    title: 'Sustainability',
    icon: Leaf,
    route: '/sustainability',
    blurb: 'Carbon, circularity and the reverse flow of parts coming back.',
    outcome:
      'ESG numbers drawn from live operations, auditable rather than reconstructed at year-end — and every reconditioned part is a part not bought.',
    moves: ['Scope 3 tCO₂e', 'Value recovered'],
    steps: [
      {
        title: 'The green ledger',
        body: 'Landfill diversion, reconditioning yield, CO₂ saved, Scope 3 against target, and WEEE compliance — which must be 100%.',
        target: at('sus-kpis'),
      },
      {
        title: 'Where the carbon sits',
        body: 'Split by leg — upstream freight, last mile, supplier transport — so it attaches to a decision someone makes.',
        target: at('sus-scope3'),
      },
      {
        title: 'The circular loop',
        body: 'Used parts from decommissioned through reconditioning back to certified stock, with the value recovered at each stage.',
        target: at('sus-reverse'),
      },
      {
        title: 'Certified, not just recovered',
        body: 'Yield per batch and BSI Kitemark certification — required before a reconditioned part re-enters van stock.',
        target: at('sus-batches'),
      },
    ],
    more: [
      {
        title: 'Against the net-zero pathway',
        body: 'A drift caught in month three is a routing change; caught in month eleven it is an offset purchase.',
        target: at('sus-trend'),
      },
    ],
  },

  // ── ATLAS ───────────────────────────────────────────────────────────────────
  {
    id: 'atlas',
    title: 'ATLAS · the AI layer',
    icon: Sparkles,
    permRoute: '/ai',
    when: ({ aiMode }) => aiMode,
    blurb: 'What the agent works on its own, what it escalates, and the audit behind both.',
    outcome:
      'Routine work handled inside guardrails, expensive decisions held for a human, and a reconstructable trail behind both — which is what makes autonomy deployable in a regulated operation.',
    moves: ['Actions per operator', 'Auditability'],
    steps: [
      {
        title: 'The master switch',
        body: 'Off, every action waits for a human. On, ATLAS works the state inside its guardrails and escalates the rest.',
        target: at('atlas-switch'),
      },
      {
        title: 'Open the Command Center',
        body: 'It sits over the page you were on, with the module rail left in place.',
        target: '.ai-orb-fab',
        act: 'Click the ATLAS orb',
      },
      {
        title: 'Approvals',
        body: 'Everything ATLAS wants to do but may not do alone, each with its reasoning, its cost and its alternative.',
        target: at('ai-tab-approvals'),
        actions: [{ click: at('ai-tab-approvals') }],
      },
      {
        title: 'Automated · 24h',
        body: 'What it handled by itself, with the time and money that accounts for — otherwise the work simply disappears from the record.',
        target: at('ai-tab-automated'),
        actions: [{ click: at('ai-tab-automated') }],
      },
      {
        title: 'Governance',
        body: 'The guardrails themselves: watch rules, spend limits and the model it reasons with. Autonomy is only as safe as its limits.',
        target: at('ai-tab-governance'),
        actions: [{ click: at('ai-tab-governance') }],
      },
    ],
    more: [
      {
        title: 'Capabilities',
        body: 'Autonomy is granted per capability, so replenishment can run itself while dispatch stays under human control.',
        target: at('ai-tab-agents'),
        actions: [{ click: at('ai-tab-agents') }],
      },
      {
        title: 'Audit log',
        body: 'Every action, automated or approved, with who took it, when, and on what evidence.',
        target: at('ai-tab-audit'),
        actions: [{ click: at('ai-tab-audit') }],
      },
      {
        title: 'Ask ATLAS',
        body: 'Question the tower in plain English and act on the answer from inside the thread.',
        target: at('ai-tab-ask'),
        actions: [{ click: at('ai-tab-ask') }],
      },
    ],
  },
]

// ─── DOM + placement helpers ──────────────────────────────────────────────────

function find(selector: string): HTMLElement | null {
  try {
    return document.querySelector(selector) as HTMLElement | null
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const CARD_W = 344
const GAP = 16
const PAD = 6

type Placement = { left: number; top: number; arrow: 'left' | 'right' | 'up' | 'down' | null }

function placeCard(rect: DOMRect | null, cardH: number): Placement {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!rect) return { left: (vw - CARD_W) / 2, top: Math.max(24, (vh - cardH) / 2), arrow: null }

  const clampTop = (t: number) => Math.min(Math.max(16, t), Math.max(16, vh - cardH - 16))
  const clampLeft = (l: number) => Math.min(Math.max(16, l), Math.max(16, vw - CARD_W - 16))

  if (vw - rect.right >= CARD_W + GAP) {
    return { left: rect.right + GAP, top: clampTop(rect.top + rect.height / 2 - cardH / 2), arrow: 'left' }
  }
  if (rect.left >= CARD_W + GAP) {
    return { left: rect.left - CARD_W - GAP, top: clampTop(rect.top + rect.height / 2 - cardH / 2), arrow: 'right' }
  }
  if (vh - rect.bottom >= cardH + GAP) {
    return { left: clampLeft(rect.left + rect.width / 2 - CARD_W / 2), top: rect.bottom + GAP, arrow: 'up' }
  }
  if (rect.top >= cardH + GAP) {
    return { left: clampLeft(rect.left + rect.width / 2 - CARD_W / 2), top: rect.top - cardH - GAP, arrow: 'down' }
  }
  // Nothing fits beside it — sit over the emptiest half.
  const top = rect.top > vh - rect.bottom ? clampTop(16) : clampTop(vh - cardH - 16)
  return { left: clampLeft(rect.left + rect.width / 2 - CARD_W / 2), top, arrow: null }
}

// ─── Component ────────────────────────────────────────────────────────────────

type View = 'welcome' | 'hub' | 'run'

interface AppTourProps {
  open: boolean
  onClose: () => void
  /** 'welcome' when the tour opened itself, 'hub' when the user asked for it. */
  initialView?: View
}

export function AppTour({ open, onClose, initialView = 'hub' }: AppTourProps) {
  const user = useStore((s) => s.user)
  const aiMode = useStore((s) => s.aiMode)
  const { canAccessPage } = usePermissions()
  const navigate = useNavigate()

  const tours = useMemo(() => TOURS.filter((t) => {
    const gate = t.permRoute ?? t.route?.split('?')[0]
    if (gate && !canAccessPage(gate)) return false
    return t.when ? t.when({ aiMode }) : true
  }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [user?.email, aiMode])

  const [view, setView] = useState<View>(initialView)
  const [tourIdx, setTourIdx] = useState(0)
  const [stepIdx, setStepIdx] = useState(0)
  const [finished, setFinished] = useState(false)
  const [done, setDone] = useState<string[]>(() => readDone(user?.email))
  const [detailed, setDetailed] = useState(false)
  const [autoShow, setAutoShow] = useState(true)

  const [rect, setRect] = useState<DOMRect | null>(null)
  const [settling, setSettling] = useState(false)
  const [cardH, setCardH] = useState(220)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const targetRef = useRef<HTMLElement | null>(null)
  const runRef = useRef(0)

  const tour = tours[Math.min(tourIdx, Math.max(0, tours.length - 1))]
  const steps = useMemo(() => {
    if (!tour) return []
    const all = detailed && tour.more ? [...tour.steps, ...tour.more] : tour.steps
    return all.filter((s) => !s.needs || canAccessPage(s.needs))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour, detailed, user?.email])
  const step = steps[Math.min(stepIdx, Math.max(0, steps.length - 1))]
  const isLast = stepIdx >= steps.length - 1

  // ── Preferences ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return
    setView(initialView)
    setFinished(false)
    if (user) {
      setAutoShow(!localStorage.getItem(optOutKey(user.email)))
      setDone(readDone(user.email))
      setDetailed(localStorage.getItem(detailKey(user.email)) === '1')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialView])

  const markDone = useCallback((id: string) => {
    setDone((prev) => {
      if (prev.includes(id)) return prev
      const nextDone = [...prev, id]
      if (user) localStorage.setItem(doneKey(user.email), JSON.stringify(nextDone))
      return nextDone
    })
  }, [user])

  function toggleDetailed() {
    const nextVal = !detailed
    setDetailed(nextVal)
    if (user) localStorage.setItem(detailKey(user.email), nextVal ? '1' : '0')
  }

  function toggleAutoShow() {
    if (!user) return
    const nextVal = !autoShow
    setAutoShow(nextVal)
    if (nextVal) localStorage.removeItem(optOutKey(user.email))
    else localStorage.setItem(optOutKey(user.email), '1')
  }

  // ── Navigation ──────────────────────────────────────────────────────────────

  const startTour = useCallback((idx: number) => {
    setTourIdx(idx)
    setStepIdx(0)
    setFinished(false)
    setRect(null)
    setView('run')
  }, [])

  const next = useCallback(() => {
    if (stepIdx + 1 < steps.length) setStepIdx(stepIdx + 1)
    else if (tour) { markDone(tour.id); setFinished(true) }
  }, [stepIdx, steps.length, tour, markDone])

  const back = useCallback(() => { if (stepIdx > 0) setStepIdx(stepIdx - 1) }, [stepIdx])

  const backToHub = useCallback(() => {
    setFinished(false)
    setRect(null)
    targetRef.current = null
    runRef.current++
    setView('hub')
  }, [])

  // ── Step engine ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open || view !== 'run' || finished || !tour || !step) return
    const runId = ++runRef.current
    const alive = () => runRef.current === runId

    async function run() {
      setSettling(true)
      setRect(null)
      targetRef.current = null

      // Only the path is compared unless the step asks for a query: a step that
      // switched a tab may have written ?tab=… into the URL, and re-navigating
      // to the bare path would undo the state it just set up.
      const wanted = step!.route ?? tour!.route
      if (wanted) {
        const [wantPath, wantQuery] = wanted.split('?')
        if (window.location.pathname !== wantPath
          || (!!wantQuery && window.location.search !== `?${wantQuery}`)) {
          navigate(wanted)
          await sleep(400)
          if (!alive()) return
        }
      }

      for (const action of step!.actions ?? []) {
        if (!alive()) return
        if (action.skipIf && find(action.skipIf)) continue
        let el: HTMLElement | null = null
        const deadline = Date.now() + (action.timeout ?? 2500)
        while (!el && Date.now() < deadline && alive()) {
          el = find(action.click)
          if (!el) await sleep(140)
        }
        if (!alive()) return
        if (el) { el.click(); await sleep(action.wait ?? 400) }
      }
      if (!alive()) return

      let el: HTMLElement | null = null
      if (step!.target) {
        for (let i = 0; i < 20 && alive(); i++) {
          el = find(step!.target)
          if (el) break
          await sleep(170)
        }
      }
      if (!alive()) return

      // A do-it-yourself step whose control is not on screen cannot be done —
      // e.g. the ATLAS orb when the panel is already open. Move on rather than
      // leaving the user staring at a prompt they cannot satisfy.
      if (!el && step!.act) { setSettling(false); next(); return }

      targetRef.current = el
      if (el) {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
        await sleep(400)
        if (!alive()) return
        setRect(el.getBoundingClientRect())
      }
      setSettling(false)
    }

    run()
    return () => { runRef.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, tourIdx, stepIdx, finished, detailed, tours])

  // A step marked `act` advances when the user clicks the spotlighted element
  // themselves. Captured on the document so it fires whatever the element does
  // with the event afterwards.
  useEffect(() => {
    if (view !== 'run' || finished || !step?.act || !step.target || settling) return
    const selector = step.target
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest(selector)) window.setTimeout(next, 480)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [view, finished, step, settling, next])

  // Keep the spotlight glued to its element: pages animate and charts resize,
  // and a rectangle measured once drifts off what it is meant to be framing.
  useEffect(() => {
    if (!open || view !== 'run' || finished) return
    const tick = () => {
      const el = targetRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setRect((prev) => (prev
        && Math.abs(prev.top - r.top) < 0.5 && Math.abs(prev.left - r.left) < 0.5
        && Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5)
        ? prev : r)
    }
    const id = window.setInterval(tick, 300)
    window.addEventListener('resize', tick)
    window.addEventListener('scroll', tick, true)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('resize', tick)
      window.removeEventListener('scroll', tick, true)
    }
  }, [open, view, finished])

  useEffect(() => {
    if (!cardRef.current) return
    const h = cardRef.current.offsetHeight
    if (h && Math.abs(h - cardH) > 4) setCardH(h)
  })

  // Keyboard. Captured and stopped so the pages underneath, which bind their own
  // window-level shortcuts, do not fire the same key.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (!['Escape', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { if (view === 'run') backToHub(); else onClose(); return }
      if (view !== 'run' || finished) return
      // An `act` step is the user's to complete — arrow keys must not skip it.
      if (e.key === 'ArrowRight') { if (!step?.act) next() }
      else back()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, view, finished, step, next, back, backToHub, onClose])

  if (!open || !tour) return null

  // ── Welcome ─────────────────────────────────────────────────────────────────

  if (view === 'welcome') {
    const firstName = user?.name?.split(' ')[0]
    return (
      <div className="tour-scrim" role="dialog" aria-modal="true" aria-label="Welcome">
        <div className="tour-sheet tour-welcome">
          <button className="tour-x tour-x-abs" onClick={onClose} aria-label="Close"><X size={15} /></button>
          <span className="tour-welcome-mark"><Compass size={22} strokeWidth={1.9} /></span>
          <h2 className="tour-welcome-title">
            {firstName ? `Welcome, ${firstName}` : 'Welcome'}
          </h2>
          <p className="tour-welcome-sub">
            This is your Logistics Control Tower. Two minutes now and you will know your way around it —
            or pick a single module and learn just that.
          </p>
          <div className="tour-welcome-actions">
            <button className="btn btn-primary btn-sm" onClick={() => startTour(0)}>
              <PlayCircle size={14} /> Take the 2-minute orientation
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setView('hub')}>
              Browse module tours
            </button>
          </div>
          <label className="tour-autoshow">
            <input type="checkbox" checked={autoShow} onChange={toggleAutoShow} />
            Show this at sign-in
          </label>
        </div>
      </div>
    )
  }

  // ── Hub ─────────────────────────────────────────────────────────────────────

  if (view === 'hub') {
    const completed = tours.filter((t) => done.includes(t.id)).length
    const pct = tours.length ? (completed / tours.length) * 100 : 0
    return (
      <div className="tour-scrim" onClick={onClose} role="dialog" aria-modal="true" aria-label="Tour hub">
        <div className="tour-sheet tour-hub" onClick={(e) => e.stopPropagation()}>
          <div className="tour-hub-head">
            <div style={{ minWidth: 0, flex: 1 }}>
              <h2 className="tour-hub-title">Learn the Control Tower</h2>
              <p className="tour-hub-sub">Short tours of the live product. Pick one — each is a few minutes.</p>
            </div>
            <button className="tour-x" onClick={onClose} aria-label="Close"><X size={15} /></button>
          </div>

          <div className="tour-progress">
            <div className="tour-progress-bar"><span style={{ width: `${pct}%` }} /></div>
            <span className="tour-progress-text">{completed} of {tours.length} complete</span>
          </div>

          <div className="tour-hub-list">
            {tours.map((t, i) => {
              const isDone = done.includes(t.id)
              const count = detailed && t.more ? t.steps.length + t.more.length : t.steps.length
              return (
                <button key={t.id} className={`tour-hub-row${isDone ? ' done' : ''}`} onClick={() => startTour(i)}>
                  <span className="tour-hub-icon"><t.icon size={15} strokeWidth={1.9} /></span>
                  <span className="tour-hub-text">
                    <span className="tour-hub-name">
                      {t.title}
                      <span className="tour-hub-meta">{count} steps</span>
                    </span>
                    <span className="tour-hub-blurb">{t.blurb}</span>
                    <span className="tour-hub-outcome">{t.outcome}</span>
                  </span>
                  <span className="tour-hub-go">
                    {isDone ? <Check size={14} strokeWidth={2.6} /> : <ChevronRight size={15} />}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="tour-hub-foot">
            <label className="tour-switch" title="Append the deeper steps — every panel and control — to each tour">
              <input type="checkbox" checked={detailed} onChange={toggleDetailed} />
              <Layers size={13} strokeWidth={1.9} />
              Detailed mode
            </label>
            <label className="tour-autoshow">
              <input type="checkbox" checked={autoShow} onChange={toggleAutoShow} />
              Show at sign-in
            </label>
          </div>
        </div>
      </div>
    )
  }

  // ── Runner ──────────────────────────────────────────────────────────────────

  const place = placeCard(finished ? null : rect, cardH)
  const interactive = !!step?.act && !!rect && !settling

  return (
    <div className="tour-layer" role="dialog" aria-modal="true" aria-label={`${tour.title} tour`}>

      {rect && !finished ? (
        <div
          className={`tour-spot${interactive ? ' interactive' : ''}`}
          style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
        />
      ) : (
        <div className="tour-dim" />
      )}

      {/* The page underneath is inert while the tour drives it. On an `act` step
          the blocker is drawn as four panes around the spotlight instead, so the
          one element the user is asked to click is the one they can reach. */}
      {interactive && rect ? (
        <>
          <div className="tour-block" style={{ left: 0, right: 0, top: 0, height: Math.max(0, rect.top - PAD) }} />
          <div className="tour-block" style={{ left: 0, right: 0, top: rect.bottom + PAD, bottom: 0 }} />
          <div className="tour-block" style={{ left: 0, width: Math.max(0, rect.left - PAD), top: rect.top - PAD, height: rect.height + PAD * 2 }} />
          <div className="tour-block" style={{ left: rect.right + PAD, right: 0, top: rect.top - PAD, height: rect.height + PAD * 2 }} />
        </>
      ) : (
        <div className="tour-block" style={{ inset: 0 }} />
      )}

      <div
        className={`tour-card${place.arrow && !finished ? ` arrow-${place.arrow}` : ''}${finished ? ' tour-card-end' : ''}`}
        ref={cardRef}
        tabIndex={-1}
        style={{ left: place.left, top: place.top }}
      >
        {finished ? (
          <>
            <div className="tour-end-head">
              <span className="tour-end-tick"><Check size={16} strokeWidth={3} /></span>
              <span>{tour.title} — done</span>
            </div>
            <div className="tour-card-body">
              <div className="tour-outcome-label">What this is worth</div>
              <p className="tour-outcome-text">{tour.outcome}</p>
              <div className="tour-moves">
                {tour.moves.map((m) => <span key={m} className="tour-move">{m}</span>)}
              </div>
            </div>
            <div className="tour-card-foot">
              <button className="btn btn-secondary btn-sm" onClick={backToHub}>
                <ChevronLeft size={13} /> All tours
              </button>
              <div style={{ flex: 1 }} />
              {tourIdx + 1 < tours.length ? (
                <button className="btn btn-primary btn-sm" onClick={() => startTour(tourIdx + 1)}>
                  Next: {tours[tourIdx + 1].title} <ArrowRight size={13} />
                </button>
              ) : (
                <button className="btn btn-primary btn-sm" onClick={onClose}>
                  Start exploring <ArrowRight size={13} />
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="tour-card-head">
              <button className="tour-crumb" onClick={backToHub} title="Back to all tours">
                <tour.icon size={11} strokeWidth={2.2} /> {tour.title}
              </button>
              <span className="tour-count">{stepIdx + 1}/{steps.length}</span>
              <button className="tour-x" onClick={onClose} title="Exit (Esc)" aria-label="Exit the tour">
                <X size={14} />
              </button>
            </div>

            <div className="tour-card-body">
              <div className="tour-title">{step.title}</div>
              <p className="tour-text">{step.body}</p>
              {step.act && (
                <div className={`tour-act${settling ? ' waiting' : ''}`}>
                  <MousePointerClick size={13} strokeWidth={2.1} />
                  {settling ? 'Finding it…' : step.act}
                </div>
              )}
            </div>

            <div className="tour-card-foot">
              <div className="tour-dots" aria-hidden="true">
                {steps.map((s, i) => (
                  <span key={`${s.title}-${i}`} className={`tour-dot${i === stepIdx ? ' active' : i < stepIdx ? ' seen' : ''}`} />
                ))}
              </div>
              <button className="tour-ghost" onClick={back} disabled={stepIdx === 0}>Back</button>
              {step.act ? (
                <button className="tour-ghost" onClick={next}>Skip</button>
              ) : (
                <button className="btn btn-primary btn-sm" onClick={next}>
                  {isLast ? 'Finish' : 'Next'} <ChevronRight size={13} />
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
