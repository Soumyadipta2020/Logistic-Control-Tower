import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useStore } from '../../store/useStore'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchExceptions, fetchAgentFleet, setAiEnabled, fetchActiveScenario } from '../../lib/api'
import { MASTER_AGENT } from '../../lib/aiTabs'
import { useWebSocket } from '../../hooks/useWebSocket'
import { useTheme } from '../../hooks/useTheme'
import { usePermissions } from '../../hooks/usePermissions'
import { AppTour, shouldAutoShowTour, markTourSessionSeen } from './AppTour'
import exlLogo from '../../assets/exl-logo.png'
import {
  LayoutDashboard, Map, Package, AlertTriangle, ShieldCheck,
  Leaf, Sun, Moon, Siren, Clapperboard,
  User, Box, Factory, Truck, Compass, LifeBuoy, X, Mail, LogOut,
  Send, Copy, Check, MessageCircleQuestion, Bug, Lightbulb,
  Sparkles, UserCheck, ChevronRight, ChevronLeft,
} from 'lucide-react'
import { AtlasGlyph } from './AtlasMark'

// The AI Command Center panel is heavy (tabs, forms, charts) — code-split it out of
// the main bundle. It's mounted persistently (not route-based) so its internal state
// survives collapsing/expanding; only visibility is toggled, via CSS.
const AiPanel = lazy(() => import('../../pages/AgentsPage').then(m => ({ default: m.AiPanel })))

const SUPPORT_EMAIL = 'Deepu.Tiwari@********.com'
const SUPPORT_NAME = 'Deepu Tiwari'
const SUPPORT_INITIALS = SUPPORT_NAME.split(' ').map(n => n[0]).join('')

const SUPPORT_TOPICS = [
  { icon: MessageCircleQuestion, label: 'General question' },
  { icon: Bug, label: 'Report a bug' },
  { icon: Lightbulb, label: 'Feature idea' },
]

function SupportModal({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(copyTimer.current)
    }
  }, [onClose])

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL)
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1800)
    } catch {
      // clipboard permission denied — mailto/manual selection still work
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Support">
      <div
        className="support-modal"
        onClick={e => e.stopPropagation()}
      >
        <button className="support-close" onClick={onClose} title="Close">
          <X size={15} strokeWidth={1.8} />
        </button>

        <div className="support-header">
          <span className="support-icon"><LifeBuoy size={20} strokeWidth={1.8} /></span>
          <div>
            <div className="support-title">Need a hand?</div>
            <div className="support-subtitle">Questions, bugs or feedback on the Control Tower</div>
          </div>
        </div>

        <div className="support-topics">
          {SUPPORT_TOPICS.map((t) => (
            <a
              key={t.label}
              className="support-topic-chip"
              href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Logistics Control Tower — ${t.label}`)}`}
            >
              <t.icon size={13} strokeWidth={1.8} />
              {t.label}
            </a>
          ))}
        </div>

        <div className="support-card">
          <span className="support-avatar">{SUPPORT_INITIALS}</span>
          <div className="support-info">
            <div className="support-name">{SUPPORT_NAME}</div>
          </div>
          <button
            className={`support-copy-btn${copied ? ' copied' : ''}`}
            onClick={copyEmail}
            title="Copy email address"
          >
            {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.8} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <a className="btn btn-primary w-full support-send-btn" href={`mailto:${SUPPORT_EMAIL}`}>
          <Send size={14} strokeWidth={1.8} />
          Email {SUPPORT_EMAIL}
        </a>

        <div className="support-footnote">Logistics Control Tower · Demo Environment</div>
      </div>
    </div>
  )
}

// ── Nav icon chip ─────────────────────────────────────────────────────────────
// Renders a lucide icon inside a soft rounded-square badge, like IMSERV's KPI icons.
function NavIcon({ icon: Icon, active }: { icon: React.ElementType; active: boolean }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 28,
      height: 28,
      borderRadius: 7,
      flexShrink: 0,
      background: active ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)',
      border: active ? '1px solid rgba(255,255,255,0.28)' : '1px solid rgba(255,255,255,0.1)',
      transition: 'background 150ms, border 150ms',
    }}>
      <Icon size={14} strokeWidth={1.8} />
    </span>
  )
}

const NAV = [
  { to: '/',               label: 'Executive Dashboard',   icon: LayoutDashboard, section: 'Overview' },
  { to: '/visibility',     label: 'Live Field Ops',   icon: Map,             section: 'Operations' },
  { to: '/transport',      label: 'Transport Control',      icon: Truck,           section: 'Operations' },
  { to: '/demand',         label: 'Demand & Inventory',    icon: Package,         section: 'Operations' },
  // IoT & Smart Tech is hidden from navigation. The route, page and API are all
  // still live — restore the entry here to bring it back.
  { to: '/sustainability', label: 'Sustainability',         icon: Leaf,            section: 'Operations' },
  { to: '/exceptions',     label: 'Exceptions',            icon: AlertTriangle,   section: 'Risk Management' },
  { to: '/simulator',      label: 'Scenario Simulator',    icon: Clapperboard,    section: 'Risk Management' },
  { to: '/risk',           label: 'Supplier & Labour Risk', icon: ShieldCheck,    section: 'Risk Management' },
]

// Module navigation — the single, permanent left sidebar. It never gets replaced by
// the AI experience: the AI layer lives in a collapsible right-hand panel instead, so
// every module stays exactly where the user expects it, in AI mode or out of it.
//
// Structurally this is a list of grouped links, so it is marked up as one: each
// section is a <ul> labelled by its own heading. That is what lets a screen
// reader announce "Operations, list, 5 items" instead of reading nine
// undifferentiated links, and what makes the grouping perceivable to someone
// who cannot see that the labels are visually smaller (SC 1.3.1).
function ModuleNav({ visibleNav, sections, p1Count }: {
  visibleNav: typeof NAV; sections: string[]; p1Count: number
}) {
  return (
    <>
      {sections.map((section) => {
        const sectionId = `nav-section-${section.replace(/\s+/g, '-').toLowerCase()}`
        return (
          <div className="nav-section" key={section}>
            <h2 className="nav-label" id={sectionId}>{section}</h2>
            <ul aria-labelledby={sectionId}>
              {visibleNav.filter((n) => n.section === section).map((item) => (
                <li key={item.to}>
                  {/* NavLink sets aria-current="page" on the active link itself,
                      so the current page reaches assistive tech rather than
                      being conveyed only by colour and the left rail. */}
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    title={item.label}
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                  >
                    {({ isActive }) => (
                      <>
                        <NavIcon icon={item.icon} active={isActive} />
                        <span>{item.label}</span>
                        {item.to === '/exceptions' && p1Count > 0 && (
                          <span className="badge">
                            {p1Count}
                            {/* The bare number means nothing out of context. */}
                            <span className="sr-only"> active P1 exceptions</span>
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </>
  )
}

// The AI presence carried into every page while AI mode is on — no per-page strip,
// just two small pills next to the master ON/OFF toggle: how much is waiting on the
// operator, and a one-click path into the panel. Always branded as ATLAS.
function TopbarAiPills({ pending, onOpenPanel }: { pending: number; onOpenPanel: (view: string) => void }) {
  return (
    <div className="topbar-ai-pills">
      {pending > 0 && (
        <button className="topbar-pill primary" onClick={() => onOpenPanel('approvals')}>
          <UserCheck size={12} strokeWidth={2.2} /> {pending} to review
        </button>
      )}
      <button className="topbar-pill" onClick={() => onOpenPanel('overview')}>
        <Sparkles size={12} strokeWidth={2.2} /> Command Center
      </button>
    </div>
  )
}

// The collapsed state of the AI Command Center — a persistent orb, fixed top-right on
// every screen. An original mark (rotating dual rings + a pulsing spark), not a copy of
// any vendor's assistant icon. Only rendered while the panel is collapsed — once it's
// open, the panel's own collapse control (top-right of the panel) takes over, so the
// two "close" affordances never sit on top of each other.
function AiOrbFab({ pending, onClick }: { pending: number; onClick: () => void }) {
  return (
    <button className="ai-orb-fab" onClick={onClick} aria-label={`Open ${MASTER_AGENT.name}`} aria-expanded={false} title={`Open ${MASTER_AGENT.name}`}>
      <span className="ai-orb-fab-ring ring-a" />
      <span className="ai-orb-fab-ring ring-b" />
      <span className="ai-orb-fab-core"><AtlasGlyph size={18} /></span>
      {pending > 0 && <span className="ai-orb-fab-badge">{pending}</span>}
    </button>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  // Use selectors so AppShell only re-renders when these specific slices change,
  // not on every store update (e.g. wsConnected changes)
  const user = useStore(s => s.user)
  const logout = useStore(s => s.logout)
  const p1Exceptions = useStore(s => s.p1Exceptions)
  const setP1Exceptions = useStore(s => s.setP1Exceptions)
  const setActiveScenario = useStore(s => s.setActiveScenario)
  const aiMode = useStore(s => s.aiMode)
  const setAiMode = useStore(s => s.setAiMode)
  const aiPanelOpen = useStore(s => s.aiPanelOpen)
  const setAiPanelOpen = useStore(s => s.setAiPanelOpen)
  const aiPanelView = useStore(s => s.aiPanelView)
  const openAiPanel = useStore(s => s.openAiPanel)

  const [p1Dismissed, setP1Dismissed] = useState(false)
  const [aiSwitching, setAiSwitching] = useState(false)
  // Narrow-viewport navigation drawer. Only has any effect below 768px, where
  // CSS turns the sidebar into an off-canvas panel; above that the sidebar is
  // always present and this flag is inert. Held in the store because the button
  // that opens it lives in PageHeader, which each page mounts for itself.
  const navOpen = useStore(s => s.navOpen)
  const setNavOpen = useStore(s => s.setNavOpen)
  const sidebarCollapsed = useStore(s => s.sidebarCollapsed)
  const toggleSidebarCollapsed = useStore(s => s.toggleSidebarCollapsed)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { theme, toggle } = useTheme()
  const { canAccessPage } = usePermissions()

  // The switch is not cosmetic. Turning ATLAS on or off re-applies the state the
  // network is in through the other variation — AI OFF leaves the disruption
  // where it landed, AI ON has ~80% of it already worked — so every module has to
  // refetch afterwards. The local flag flips first so the UI stays responsive.
  const toggleAi = useCallback(async (on: boolean) => {
    setAiMode(on)
    setAiSwitching(true)
    try {
      await setAiEnabled(on)
      await queryClient.invalidateQueries({ refetchType: 'all' })
    } catch {
      // The panel is still usable on the last-known state; the next poll re-syncs.
    } finally {
      setAiSwitching(false)
    }
  }, [setAiMode, queryClient])

  // In-app tour. Opening it by itself once per session shows the welcome card —
  // an invitation with a skip, not a walkthrough that starts playing at you.
  // Opening it from the sidebar goes straight to the hub of module tours.
  const [tour, setTour] = useState<{ open: boolean; view: 'welcome' | 'hub' }>(
    () => ({ open: shouldAutoShowTour(user?.email), view: 'welcome' }),
  )
  useEffect(() => { markTourSessionSeen() }, [])

  const [supportOpen, setSupportOpen] = useState(false)

  // Polled fallback so the P1 banner self-heals even if a WS message is missed
  // (e.g. reconnect gap, or state changed from another tab/session).
  const { data: openP1Poll } = useQuery({
    queryKey: ['exceptions-open'],
    queryFn: () => fetchExceptions('P1', 'open'),
    refetchInterval: 120_000,
  })

  useEffect(() => {
    if (!openP1Poll) return
    const polled = (openP1Poll.items ?? []) as any[]
    setP1Exceptions((prev) => {
      const same = prev.length === polled.length
        && prev.every((e, i) => e.exception_code === polled[i]?.exception_code)
      return same ? prev : polled
    })
  }, [openP1Poll, setP1Exceptions])

  // The applied scenario is server state, but the store copy was only ever written
  // by the tab that ran the scenario — so a reload, or a second tab, showed
  // "no scenario active" while every module rendered that scenario's data
  // (SimulatorPage's banner and RiskPage's labour-scenario note both read it).
  // Hydrate it from the server here, in the shell, so it is right everywhere.
  // Shares the ['active-scenario'] key with DashboardPage/AiInsights, so it adds
  // no request when either of those is mounted.
  const { data: activeScn } = useQuery({
    queryKey: ['active-scenario'],
    queryFn: fetchActiveScenario,
    refetchInterval: 15_000,
  })
  useEffect(() => {
    if (!activeScn) return
    setActiveScenario(activeScn.scenario_id ?? null)
  }, [activeScn, setActiveScenario])

  // Stable callback — must not be recreated on every render or the WebSocket
  // will reconnect on every render (connect() has onMessage as a dep)
  const handleWsMessage = useCallback((type: string, payload: unknown) => {
    if (type === 'p1_active' && Array.isArray(payload)) {
      setP1Exceptions(payload as any[])
      setP1Dismissed(false)
    }
  }, [setP1Exceptions])

  useWebSocket('exceptions', handleWsMessage)

  // Escape closes the nav drawer, matching every other dismissible surface in
  // the app. Bound only while it is open so it never competes with the AI
  // panel's own Escape handling (SC 2.1.2 — no keyboard trap).
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  // Live fleet metrics for the orb badge — only when the user can use it and AI mode is on.
  const canAI = canAccessPage('/ai')
  const { data: aiFleet } = useQuery({
    queryKey: ['agent-fleet-badge'],
    queryFn: fetchAgentFleet,
    refetchInterval: 30_000,
    enabled: canAI && aiMode,
  })
  const aiPending = aiFleet?.metrics?.pending_approvals ?? 0

  const showP1 = p1Exceptions.length > 0 && !p1Dismissed
  const visibleNav = NAV.filter((n) => canAccessPage(n.to))
  const sections = [...new Set(visibleNav.map((n) => n.section))]

  return (
    <div className={`app-shell${aiMode ? ' ai-mode' : ''}${aiPanelOpen ? ' panel-open' : ''}${navOpen ? ' nav-open' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      {/*
        Bypass block (SC 2.4.1). Without it, every navigation costs a keyboard
        or switch user nine tab stops through the sidebar before reaching any
        page content. Visually hidden until focused, then it appears top-left.
      */}
      <a className="skip-link" href="#main-content">Skip to main content</a>

      {/*
        Landmarks. There was previously one <nav> with no accessible name and no
        <main> at all, so landmark navigation — the primary way a screen-reader
        user moves around an app this dense — had nothing to offer. The nav is
        named because a page may hold more than one (SC 1.3.1, 2.4.1).
      */}
      {/* Scrim behind the open drawer. A real <button> rather than a div so it
          is reachable and operable by keyboard, not mouse-only. */}
      <button
        type="button"
        className="nav-scrim"
        onClick={() => setNavOpen(false)}
        aria-label="Close navigation menu"
        tabIndex={navOpen ? 0 : -1}
      />

      <nav
        className="sidebar"
        aria-label="Modules"
        // Choosing a destination dismisses the drawer — the click bubbles up
        // from whichever NavLink was activated. Without this the drawer stays
        // over the page the user just asked for. Inert above 768px, where the
        // sidebar is permanent and navOpen is never set.
        onClick={() => { if (navOpen) setNavOpen(false) }}
      >
        {/* Logo */}
        <div className="sidebar-logo">
          {/* The wordmark is decorative here: the product name follows it as
              real text, so alt text would just be read twice. */}
          <img src={exlLogo} alt="" style={{ height: 22, display: 'block' }} />
          <div className="product">Logistics Control Tower</div>
          <div className="version">v1.0 · Demo Mode</div>
        </div>

        {/* Nav — the one permanent spine, always the modules. The AI layer never
            replaces it; it lives in the collapsible panel on the right instead. */}
        <div className="sidebar-nav">
          <ModuleNav visibleNav={visibleNav} sections={sections} p1Count={p1Exceptions.length} />
        </div>

        {/* Footer */}
        <div className="sidebar-footer">
          <div className="user-name">{user?.name}</div>
          <div className="user-role">{user?.role?.replace(/_/g, ' ')}</div>
          <div className="sidebar-footer-actions">
            <button
              className="footer-icon-btn"
              onClick={() => setTour({ open: true, view: 'hub' })}
              title="Learn the Control Tower — short tours of each module"
            >
              <Compass size={15} strokeWidth={1.8} />
              <span>Tour</span>
            </button>
            <button
              className="footer-icon-btn"
              onClick={toggle}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark'
                ? <Sun size={15} strokeWidth={1.8} />
                : <Moon size={15} strokeWidth={1.8} />}
              <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
            <button
              className="footer-icon-btn"
              onClick={() => setSupportOpen(true)}
              title="Contact support"
            >
              <LifeBuoy size={15} strokeWidth={1.8} />
              <span>Support</span>
            </button>
            <button
              className="footer-icon-btn footer-icon-btn-danger"
              onClick={() => { logout(); navigate('/login') }}
              title="Sign out"
            >
              <LogOut size={15} strokeWidth={1.8} />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </nav>

      {/* Collapse handle — desktop only (see .sidebar-collapse-toggle's own
          media query). Anchored to the app shell rather than the sidebar
          itself, straddling the boundary between the two — the same
          construction as the AI panel's edge-collapse control, so the two
          "shrink this rail" gestures in the app read as one idiom. */}
      <button
        type="button"
        className="sidebar-collapse-toggle"
        onClick={toggleSidebarCollapsed}
        aria-expanded={!sidebarCollapsed}
        aria-label={sidebarCollapsed ? 'Expand navigation menu' : 'Collapse navigation menu'}
        title={sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
      >
        <ChevronLeft size={13} strokeWidth={2.4} />
      </button>

      <div className="main-content">
        {/* Global top bar — the agentic ON/OFF switch, centred as the one control that
            decides whether the whole AI layer (orb, panel, pills) is present at all. */}
        {canAccessPage('/agents') && (
          <div className="topbar">
            <div className="topbar-side" />
            <div className="topbar-center" data-tour="atlas-switch">
              <span className="topbar-ai-heading">
                <AtlasGlyph size={14} strokeWidth={2.1} /> {MASTER_AGENT.name}{' '}
                <span className="topbar-ai-state">({aiSwitching ? 'Applying…' : aiMode ? 'On' : 'Off'})</span>
              </span>
              <button
                className={`ai-switch${aiMode ? ' on' : ''}${aiSwitching ? ' busy' : ''}`}
                onClick={() => !aiSwitching && toggleAi(!aiMode)}
                role="switch"
                aria-checked={aiMode}
                aria-busy={aiSwitching}
                disabled={aiSwitching}
                title={aiMode
                  ? `Turn ${MASTER_AGENT.name} off — the network reverts to the unworked state, every action waits for a human`
                  : `Turn ${MASTER_AGENT.name} on — ATLAS works the state autonomously inside its guardrails and escalates the rest`}
              >
                <span className="ai-switch-label off-label">OFF</span>
                <span className="ai-switch-track"><span className="ai-switch-knob">{aiMode ? <AtlasGlyph size={14} strokeWidth={2.3} /> : null}</span></span>
                <span className="ai-switch-label on-label">AI</span>
              </button>
              {canAI && aiMode && <TopbarAiPills pending={aiPending} onOpenPanel={(v) => openAiPanel(v)} />}
            </div>
            <div className="topbar-side" />
          </div>
        )}
        {/*
          The most urgent surface in the product, and previously the least
          accessible: it announced nothing, and its only "dismiss" affordance was
          a bare × glyph with no name and no hit area of its own.

          role="alert" (an assertive live region) means a P1 arriving while the
          operator is working elsewhere interrupts and is spoken immediately —
          which is the entire point of a P1. The severity is carried by the
          words "P1 ACTIVE", not by the red (SC 1.4.1, 4.1.3, 2.5.8).
        */}
        {showP1 && (
          <div className="p1-banner" role="alert">
            <Siren size={14} strokeWidth={2} aria-hidden="true" />
            <span>P1 ACTIVE: {p1Exceptions[0]?.title}</span>
            {p1Exceptions.length > 1 && (
              <span>+{p1Exceptions.length - 1} more</span>
            )}
            <button
              className="dismiss"
              onClick={() => setP1Dismissed(true)}
              aria-label="Dismiss P1 alert banner"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        )}

        {/*
          The main landmark and the skip link's destination. tabIndex={-1} makes
          it programmatically focusable so the skip link moves the actual focus
          point rather than only scrolling — without which the next Tab press
          would drop the user back at the top of the sidebar (SC 2.4.3).
        */}
        <main id="main-content" className="app-main" tabIndex={-1}>
          {children}
        </main>
      </div>

      {/* AI Command Center — collapsible right panel. Collapsed it's just the orb;
          expanded it covers everything right of the module sidebar, which stays put
          so the user never loses their place. Opened from the orb or the topbar pills. */}
      {canAI && aiMode && (
        <>
          {/* Scrim. What actually makes the pane read as overlaid: the page is still
              there underneath, dimmed and pushed out of focus. Clicking it collapses. */}
          <div
            className={`ai-panel-scrim${aiPanelOpen ? ' open' : ''}`}
            onClick={() => setAiPanelOpen(false)}
            aria-hidden
          />
          <div className={`ai-panel-shell${aiPanelOpen ? ' open' : ''}`} aria-hidden={!aiPanelOpen}>
            {/* Collapse handle. It rides the pane's own left boundary rather than
                sitting in the topbar, so the gesture matches what it does: push the
                overlay back off the right edge. Arrows animate rightwards to say so. */}
            <button
              className="ai-panel-edge-collapse"
              onClick={() => setAiPanelOpen(false)}
              title="Collapse AI Command Center (Esc)"
              aria-label="Collapse AI Command Center"
              tabIndex={aiPanelOpen ? 0 : -1}
            >
              <span className="ai-panel-edge-chevrons">
                <ChevronRight size={13} strokeWidth={2.6} />
                <ChevronRight size={13} strokeWidth={2.6} />
              </span>
            </button>
            <Suspense fallback={<div className="ai-panel-loading"><span className="ai-orb-fab-core" style={{ position: 'static' }}><AtlasGlyph size={18} /></span> Loading AI Command Center…</div>}>
              <AiPanel
                open={aiPanelOpen}
                view={aiPanelView}
                onViewChange={(v) => openAiPanel(v)}
                onOpenModule={(m) => { setAiPanelOpen(false); navigate(m) }}
                onClose={() => setAiPanelOpen(false)}
              />
            </Suspense>
          </div>
          {!aiPanelOpen && <AiOrbFab pending={aiPending} onClick={() => setAiPanelOpen(true)} />}
        </>
      )}

      <AppTour
        open={tour.open}
        initialView={tour.view}
        onClose={() => setTour((t) => ({ ...t, open: false }))}
      />
      {supportOpen && <SupportModal onClose={() => setSupportOpen(false)} />}
    </div>
  )
}
