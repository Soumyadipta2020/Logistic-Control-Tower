import { create } from 'zustand'

interface User {
  email: string
  name: string
  role: string
  permissions: string[]
}

interface Exception {
  exception_code: string
  priority: string
  title: string
  status: string
  category: string
  impacted_engineer_count: number
  created_at: string
}

interface CLTState {
  user: User | null
  token: string | null
  p1Exceptions: Exception[]
  wsConnected: boolean
  demoScenarioOpen: boolean
  activeScenario: string | null
  aiMode: boolean
  aiPanelOpen: boolean
  aiPanelView: string
  /**
   * Narrow-viewport navigation drawer.
   *
   * Lives in the store rather than in AppShell because the control that opens
   * it belongs in the page header — where a user looks for a menu — while the
   * drawer itself is rendered by the shell. PageHeader is mounted separately by
   * each page, so the two cannot share local state.
   *
   * Has no effect above 768px, where the sidebar is permanently visible.
   */
  navOpen: boolean
  /**
   * Desktop sidebar collapse — icon-only rail. Independent of `navOpen`
   * (the mobile drawer): this only applies above 768px, where the sidebar
   * is permanent and would otherwise always claim its full width. Persisted
   * so the choice survives a reload.
   */
  sidebarCollapsed: boolean

  setUser: (user: User, token: string) => void
  logout: () => void
  setP1Exceptions: (exceptions: Exception[] | ((prev: Exception[]) => Exception[])) => void
  setWsConnected: (connected: boolean) => void
  setDemoScenarioOpen: (open: boolean) => void
  setActiveScenario: (scenario: string | null) => void
  setAiMode: (on: boolean) => void
  setAiPanelOpen: (open: boolean) => void
  openAiPanel: (view?: string) => void
  setNavOpen: (open: boolean) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebarCollapsed: () => void
}

export const useStore = create<CLTState>((set) => ({
  user: (() => {
    try { return JSON.parse(localStorage.getItem('clt_user') || 'null') } catch { return null }
  })(),
  token: localStorage.getItem('clt_token'),
  p1Exceptions: [],
  wsConnected: false,
  demoScenarioOpen: false,
  activeScenario: null,
  aiMode: (() => {
    const saved = localStorage.getItem('clt_ai_mode')
    return saved === null ? true : saved === 'true'   // agentic UI on by default
  })(),
  aiPanelOpen: false,
  aiPanelView: 'overview',
  navOpen: false,
  sidebarCollapsed: localStorage.getItem('clt_sidebar_collapsed') === 'true',

  setUser: (user, token) => {
    localStorage.setItem('clt_token', token)
    localStorage.setItem('clt_user', JSON.stringify(user))
    set({ user, token })
  },

  logout: () => {
    localStorage.removeItem('clt_token')
    localStorage.removeItem('clt_user')
    // Next sign-in is a new session — let the in-app tour auto-open again
    sessionStorage.removeItem('clt_tour_seen')
    set({ user: null, token: null })
  },

  setP1Exceptions: (exceptions) => set((state) => ({
    p1Exceptions: typeof exceptions === 'function' ? exceptions(state.p1Exceptions) : exceptions,
  })),
  setWsConnected: (connected) => set({ wsConnected: connected }),
  setDemoScenarioOpen: (open) => set({ demoScenarioOpen: open }),
  setActiveScenario: (scenario) => set({ activeScenario: scenario }),
  setAiMode: (on) => {
    localStorage.setItem('clt_ai_mode', String(on))
    set((state) => ({ aiMode: on, aiPanelOpen: on ? state.aiPanelOpen : false }))
  },
  setAiPanelOpen: (open) => set({ aiPanelOpen: open }),
  // Opens the panel to a given tab (or wherever it already was) — the single entry
  // point used by the orb button and every "Command Center" / "N to review" link
  // scattered across module pages, so they all behave identically.
  openAiPanel: (view) => set((state) => ({ aiPanelOpen: true, aiPanelView: view ?? state.aiPanelView })),
  setNavOpen: (open) => set({ navOpen: open }),
  setSidebarCollapsed: (collapsed) => {
    localStorage.setItem('clt_sidebar_collapsed', String(collapsed))
    set({ sidebarCollapsed: collapsed })
  },
  toggleSidebarCollapsed: () => set((state) => {
    const next = !state.sidebarCollapsed
    localStorage.setItem('clt_sidebar_collapsed', String(next))
    return { sidebarCollapsed: next }
  }),
}))
