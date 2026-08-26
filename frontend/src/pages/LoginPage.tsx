import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore'
import { login, fetchDemoUsers } from '../lib/api'
import { useQuery } from '@tanstack/react-query'
import { useTheme } from '../hooks/useTheme'
import exlLogo from '../assets/exl-logo.png'
import {
  Map, Truck, ShieldCheck, Leaf, Radio, Sun, Moon,
  Eye, EyeOff, ArrowRight, Sparkles,
  Briefcase, Wrench, LineChart, Recycle, PackageSearch,
  Mail, Lock, AlertCircle, Loader2,
  Package, Cpu, ChevronLeft, ChevronRight,
} from 'lucide-react'
import {
  MapGraphic, TruckGraphic, InventoryGraphic, IotGraphic, SustainabilityGraphic, RiskGraphic,
} from '../components/ui/LoginGraphics'

// Decorative, illustrative-only figures for the showcase carousel — not live data.
// Mirrors the app's actual module set (see AppShell's NAV) so the pitch matches the product.
const CAPABILITIES = [
  {
    icon: Map,
    graphic: MapGraphic,
    label: 'Live Field Ops',
    desc: 'Every van, shipment and site tracked on a live map, with geofenced alerts the moment something drifts off-plan.',
  },
  {
    icon: Truck,
    graphic: TruckGraphic,
    label: 'Transport Control',
    desc: 'Route optimisation, carrier SLAs and delivery ETAs in one console — reroute before a delay becomes a miss.',
  },
  {
    icon: Package,
    graphic: InventoryGraphic,
    label: 'Demand & Inventory',
    desc: 'Forecast demand and balance stock across depots and vans, so engineers never roll without the right part.',
  },
  {
    icon: Cpu,
    graphic: IotGraphic,
    label: 'IoT & Smart Tech',
    desc: 'Real-time telemetry from smart meters, sensors and connected assets, feeding straight into the control tower.',
  },
  {
    icon: Leaf,
    graphic: SustainabilityGraphic,
    label: 'Sustainability',
    desc: 'Carbon footprint, reverse logistics and ESG targets tracked alongside operational performance, not apart from it.',
  },
  {
    icon: ShieldCheck,
    graphic: RiskGraphic,
    label: 'Supplier & Labour Risk',
    desc: 'Predictive risk scoring across suppliers, weather and workforce — see disruption coming before it lands.',
  },
]

const STATS = [
  { value: '98.4%', label: 'On-Time Delivery' },
  { value: '1,240', label: 'Active Shipments' },
  { value: '24/7', label: 'Control Tower Coverage' },
]

const ROLE_ICON: Record<string, React.ElementType> = {
  supply_chain_director: Briefcase,
  logistics_ops: Truck,
  field_dispatcher: Radio,
  finance_analyst: LineChart,
  engineer: Wrench,
  sustainability_manager: Recycle,
  procurement_manager: PackageSearch,
}

export function LoginPage() {
  const [email, setEmail] = useState('supply.director@abc.com')
  const [password, setPassword] = useState('demo1234')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const setUser = useStore(s => s.setUser)
  const navigate = useNavigate()
  const { theme, toggle } = useTheme()

  const { data: demoUsers } = useQuery({ queryKey: ['demo-users'], queryFn: fetchDemoUsers })

  const time = useMemo(() => {
    const now = new Date()
    return now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }, [])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await login(email, password)
      setUser(res.user, res.access_token)
      navigate('/')
    } catch (err: any) {
      if (err?.code === 'ECONNABORTED' || err?.message?.includes('timeout')) {
        setError('Backend is waking up — please try again in a moment.')
      } else if (err?.response?.status === 401) {
        setError('Invalid credentials')
      } else {
        setError('Cannot reach server. Check your connection or try again shortly.')
      }
    } finally {
      setLoading(false)
    }
  }

  // ── Capability carousel ──────────────────────────────────────────────────
  // Auto-advances every 5.5s; pauses on hover/focus and respects
  // prefers-reduced-motion. Manual nav (arrows/dots) always works.
  const [slide, setSlide] = useState(0)
  const [paused, setPaused] = useState(false)
  const reduceMotion = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    [],
  )

  useEffect(() => {
    if (paused || reduceMotion) return
    const id = setInterval(() => setSlide((s) => (s + 1) % CAPABILITIES.length), 5500)
    return () => clearInterval(id)
  }, [paused, reduceMotion])

  const goTo = (i: number) => setSlide((i + CAPABILITIES.length) % CAPABILITIES.length)

  return (
    <div className="login-page">
      {/* ── Showcase panel ─────────────────────────────────────────────── */}
      <div className="login-showcase">
        <div className="login-showcase-glow" />
        <div className="login-showcase-inner">
          <div className="login-showcase-top">
            <img src={exlLogo} alt="EXL" style={{ height: 26, display: 'block' }} />
            <div className="login-live-chip">
              <span className="login-live-dot" />
              Live · {time} GMT
            </div>
          </div>

          <div className="login-showcase-body">
            <div className="login-eyebrow">
              <Sparkles size={13} strokeWidth={2} />
              Field-Service Supply Chain, One Screen
            </div>
            <h1 className="login-headline">
              Command your logistics<br />network in real time.
            </h1>
            <p className="login-subcopy">
              The Logistics Control Tower unifies fleet visibility, inventory, supplier risk,
              IoT telemetry and sustainability into a single command centre — built for
              ABC's Home Solutions &amp; Smart Energy operations.
            </p>

            <div
              className="login-carousel"
              onMouseEnter={() => setPaused(true)}
              onMouseLeave={() => setPaused(false)}
              onFocus={() => setPaused(true)}
              onBlur={() => setPaused(false)}
            >
              <div className="login-carousel-viewport">
                <div
                  className="login-carousel-track"
                  style={{ transform: `translateX(-${slide * 100}%)` }}
                  aria-live="polite"
                >
                  {CAPABILITIES.map((c) => (
                    <div className="login-carousel-slide" key={c.label} aria-hidden={c !== CAPABILITIES[slide]}>
                      <div className="login-carousel-graphic">
                        <c.graphic />
                      </div>
                      <div className="login-carousel-body">
                        <div className="login-carousel-label">
                          <span className="login-carousel-icon"><c.icon size={15} strokeWidth={1.8} /></span>
                          {c.label}
                        </div>
                        <div className="login-carousel-desc">{c.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="login-carousel-controls">
                <button
                  type="button"
                  className="login-carousel-arrow"
                  onClick={() => goTo(slide - 1)}
                  aria-label="Previous capability"
                >
                  <ChevronLeft size={15} strokeWidth={2} />
                </button>
                <div className="login-carousel-dots">
                  {CAPABILITIES.map((c, i) => (
                    <button
                      type="button"
                      key={c.label}
                      className={`login-carousel-dot${i === slide ? ' active' : ''}`}
                      onClick={() => goTo(i)}
                      aria-label={`Show ${c.label}`}
                      aria-current={i === slide}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  className="login-carousel-arrow"
                  onClick={() => goTo(slide + 1)}
                  aria-label="Next capability"
                >
                  <ChevronRight size={15} strokeWidth={2} />
                </button>
              </div>
            </div>

            <blockquote className="login-quote">
              <p>
                "One screen replaced four separate systems for us — dispatch, stock, supplier
                risk and carbon reporting. We see a problem and act on it in the same breath."
              </p>
              <footer>Supply Chain Director · Field Operations</footer>
            </blockquote>
          </div>

          <div className="login-showcase-footer">
            <div className="login-stat-strip">
              {STATS.map((s) => (
                <div className="login-stat" key={s.label}>
                  <div className="login-stat-value">{s.value}</div>
                  <div className="login-stat-label">{s.label}</div>
                </div>
              ))}
            </div>
            <div className="login-showcase-bottomline">
              Built for ABC's Home Solutions &amp; Smart Energy field operations
            </div>
          </div>
        </div>
      </div>

      {/* ── Form panel ─────────────────────────────────────────────────── */}
      <div className="login-panel">
        <button
          className="login-theme-toggle"
          onClick={toggle}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun size={14} strokeWidth={1.8} /> : <Moon size={14} strokeWidth={1.8} />}
        </button>

        <div className="login-card">
          <div className="login-logo login-logo-mobile">
            <img src={exlLogo} alt="EXL" style={{ height: 32, display: 'block', margin: '0 auto 8px' }} />
          </div>

          <div className="login-card-header">
            <div className="login-eyebrow-mini">Logistics Control Tower</div>
            <h1 className="login-heading">Welcome back</h1>
            <p className="login-heading-sub">Sign in to access your control tower</p>
          </div>

          <form className="login-form" onSubmit={handleLogin} noValidate>
            <div className="form-group">
              <label className="form-label" htmlFor="login-email">Email</label>
              <div className="login-input-wrap">
                <Mail className="login-input-icon" size={15} strokeWidth={1.8} />
                <input
                  id="login-email"
                  className="form-input login-input-icon-pad"
                  type="email"
                  autoComplete="username"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="login-password">Password</label>
              <div className="login-input-wrap">
                <Lock className="login-input-icon" size={15} strokeWidth={1.8} />
                <input
                  id="login-password"
                  className="form-input login-input-icon-pad login-input-icon-pad-r"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="login-password-toggle"
                  onClick={() => setShowPassword(v => !v)}
                  title={showPassword ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={15} strokeWidth={1.8} /> : <Eye size={15} strokeWidth={1.8} />}
                </button>
              </div>
            </div>
            {error && (
              <div className="login-error">
                <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{error}</span>
              </div>
            )}
            <button className="btn btn-primary w-full login-submit" type="submit" disabled={loading}>
              {loading
                ? (<><Loader2 size={15} strokeWidth={2} className="login-spinner" /><span>Signing in…</span></>)
                : (<><span>Sign In</span><ArrowRight size={15} strokeWidth={2} /></>)}
            </button>
          </form>

          {demoUsers && (
            <div className="demo-users">
              <div className="login-demo-header">
                <span className="login-demo-title">Quick demo access</span>
                <span className="login-demo-hint">click a persona to autofill</span>
              </div>
              <div className="demo-user-grid">
                {demoUsers.map((u: any) => {
                  const Icon = ROLE_ICON[u.role] ?? Briefcase
                  const active = u.email === email
                  return (
                    <button
                      type="button"
                      key={u.email}
                      className={`demo-user-chip${active ? ' active' : ''}`}
                      onClick={() => { setEmail(u.email); setPassword('demo1234'); setError('') }}
                      title={u.email}
                    >
                      <span className="demo-user-chip-icon"><Icon size={14} strokeWidth={1.8} /></span>
                      <span className="demo-user-chip-text">
                        <span className="demo-user-chip-name">{u.name}</span>
                        <span className="demo-user-chip-role">{u.role.replace(/_/g, ' ')}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div className="login-footnote">Engineering Solution v1.0 · Demo Mode</div>
        </div>
      </div>
    </div>
  )
}
