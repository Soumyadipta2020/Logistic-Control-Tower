import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from './context/ThemeContext'
import { useStore } from './store/useStore'
import { usePermissions, PAGE_PERMISSIONS } from './hooks/usePermissions'
import { AppShell } from './components/ui/AppShell'
import { LoginPage } from './pages/LoginPage'

// Route-level code splitting — each page is a separate chunk.
// VisibilityPage is the biggest win: it brings in Leaflet (~200 KB).
const DashboardPage    = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })))
const VisibilityPage   = lazy(() => import('./pages/VisibilityPage').then(m => ({ default: m.VisibilityPage })))
const TransportPage    = lazy(() => import('./pages/TransportPage').then(m => ({ default: m.TransportPage })))
const DemandPage       = lazy(() => import('./pages/DemandPage').then(m => ({ default: m.DemandPage })))
const RiskPage         = lazy(() => import('./pages/RiskPage').then(m => ({ default: m.RiskPage })))
const IoTPage          = lazy(() => import('./pages/IoTPage').then(m => ({ default: m.IoTPage })))
const SustainabilityPage = lazy(() => import('./pages/SustainabilityPage').then(m => ({ default: m.SustainabilityPage })))
const ExceptionsPage   = lazy(() => import('./pages/ExceptionsPage').then(m => ({ default: m.ExceptionsPage })))
const SimulatorPage    = lazy(() => import('./pages/SimulatorPage').then(m => ({ default: m.SimulatorPage })))

// The AI Command Center is no longer a routed page — it's a collapsible panel that
// AppShell mounts everywhere. /ai and /agents are kept as bookmarkable entry points:
// landing on either opens the panel over wherever the dashboard is, then drops the URL.
function AiEntry() {
  const setAiMode = useStore((s) => s.setAiMode)
  const openAiPanel = useStore((s) => s.openAiPanel)
  useEffect(() => { setAiMode(true); openAiPanel('overview') }, [setAiMode, openAiPanel])
  return <Navigate to="/" replace />
}

function PageLoader() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', color: 'var(--text-secondary)', fontSize: 13,
    }}>
      Loading…
    </div>
  )
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, logout } = useStore((s) => ({ user: s.user, logout: s.logout }))
  if (!user) return <Navigate to="/login" replace />
  if (!user.permissions?.length) {
    logout()
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

function PermissionRoute({ anyOf, children }: { anyOf: string[]; children: React.ReactNode }) {
  const { canAny } = usePermissions()
  if (!canAny(...anyOf)) {
    const target = Object.keys(PAGE_PERMISSIONS).find((path) =>
      PAGE_PERMISSIONS[path].some((p) => canAny(p))
    ) ?? '/login'
    return <Navigate to={target} replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <ThemeProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <AppShell>
                <Suspense fallback={<PageLoader />}>
                  <Routes>
                    <Route path="/" element={
                      <PermissionRoute anyOf={PAGE_PERMISSIONS['/']}>
                        <DashboardPage />
                      </PermissionRoute>
                    } />
                    <Route path="/ai" element={
                      <PermissionRoute anyOf={PAGE_PERMISSIONS['/ai']}>
                        <AiEntry />
                      </PermissionRoute>
                    } />
                    <Route path="/agents" element={<AiEntry />} />
                    <Route path="/visibility" element={
                      <PermissionRoute anyOf={PAGE_PERMISSIONS['/visibility']}>
                        <VisibilityPage />
                      </PermissionRoute>
                    } />
                    <Route path="/transport" element={
                      <PermissionRoute anyOf={PAGE_PERMISSIONS['/transport']}>
                        <TransportPage />
                      </PermissionRoute>
                    } />
                    <Route path="/demand" element={
                      <PermissionRoute anyOf={PAGE_PERMISSIONS['/demand']}>
                        <DemandPage />
                      </PermissionRoute>
                    } />
                    <Route path="/iot" element={
                      <PermissionRoute anyOf={PAGE_PERMISSIONS['/iot']}>
                        <IoTPage />
                      </PermissionRoute>
                    } />
                    <Route path="/sustainability" element={
                      <PermissionRoute anyOf={PAGE_PERMISSIONS['/sustainability']}>
                        <SustainabilityPage />
                      </PermissionRoute>
                    } />
                    {/* Risk Management section — dedicated pages */}
                    <Route path="/exceptions" element={
                      <PermissionRoute anyOf={PAGE_PERMISSIONS['/exceptions']}>
                        <ExceptionsPage />
                      </PermissionRoute>
                    } />
                    <Route path="/simulator" element={
                      <PermissionRoute anyOf={PAGE_PERMISSIONS['/simulator']}>
                        <SimulatorPage />
                      </PermissionRoute>
                    } />
                    <Route path="/risk" element={
                      <PermissionRoute anyOf={PAGE_PERMISSIONS['/risk']}>
                        <RiskPage />
                      </PermissionRoute>
                    } />
                    {/* Legacy redirects */}
                    <Route path="/risk-management" element={<Navigate to="/exceptions" replace />} />
                    <Route path="/analytics" element={<Navigate to="/" replace />} />
                  </Routes>
                </Suspense>
              </AppShell>
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
    </ThemeProvider>
  )
}
