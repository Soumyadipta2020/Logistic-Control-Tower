/**
 * Telemetry primitives — the shared vocabulary for the two live operations
 * surfaces (Transport Control, Live Visibility Hub).
 *
 * Why these exist
 * ---------------
 * Both pages render numbers that change while you are looking at them, on a
 * screen somebody watches for a whole shift. That is a specific design problem
 * and it has known answers, none of which the pages had:
 *
 *   · a value that changes silently is a value nobody notices changing, so
 *     `LiveValue` flashes the delta for one beat when it moves;
 *   · a dashboard with no freshness signal cannot be trusted after the feed
 *     stops, so `FreshnessMeter` states the age of the data out loud and goes
 *     amber then red as it ages;
 *   · a spinner tells you nothing about what is arriving, so `Skeleton`
 *     suggests the shape of the content instead;
 *   · a number without its recent history is a number you cannot judge, so
 *     `Sparkline` carries twelve points of context in 60 pixels.
 *
 * Everything here is built on the app's own tokens rather than raw hex. That is
 * not tidiness: `colors.ts` documents that dark mode is deliberately NOT an
 * inversion — status foregrounds move to the pale end of each ramp because "the
 * saturated mid-tones that read well on white turn muddy on near-black". A
 * component that hardcodes #EF4444 opts out of that and lands at roughly 3.3:1
 * on the dark surface, where the token it bypassed (#FCA5A5) is 9.4:1.
 *
 * Motion respects `prefers-reduced-motion` — the app already guards its CSS
 * animations that way and these must not be the exception.
 */
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Info, Minus, RefreshCw, TrendingDown, TrendingUp, X } from 'lucide-react'
import { useTheme } from '../../hooks/useTheme'
import type { AppColors } from '../../lib/colors'

// ── Motion preference ───────────────────────────────────────────────────────
// Read once and kept live. Every animation in this file is gated on it.

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

// ── Tones ───────────────────────────────────────────────────────────────────
// One place that turns an operational state into colour. Call sites name the
// STATE ("this van is off duty"), never the colour, so light and dark mode are
// decided here and cannot drift apart per page.

export type ToneName = 'success' | 'warning' | 'danger' | 'info' | 'ai' | 'neutral' | 'accent'

export interface Tone {
  /** Filled marks, map pins, meter fills. Legible against a surface, not text. */
  solid: string
  /** Text and icons on the page surface — the AA-verified step for the mode. */
  text: string
  bg: string
  border: string
}

export function tone(c: AppColors, name: ToneName): Tone {
  switch (name) {
    case 'success': return c.success
    case 'warning': return c.warning
    case 'danger': return c.danger
    case 'info': return c.info
    case 'ai': return c.ai
    case 'accent': return {
      solid: c.accentSolid, text: c.accentText,
      bg: c.accentSubtle, border: c.accentSolid,
    }
    default: return c.neutral
  }
}

export function useTone(name: ToneName): Tone {
  const { c } = useTheme()
  return tone(c, name)
}

/** Van / engineer working state → tone. The two pages had separate hex maps
 *  for the identical five states; this is the one both now read. */
export const VAN_STATE_TONE: Record<string, ToneName> = {
  available: 'success',
  en_route: 'info',
  on_site: 'warning',
  break: 'neutral',
  off_duty: 'neutral',
}

/** Alert severity → tone, shared by van-stock, locker, carrier and ETA rows. */
export const SEVERITY_TONE: Record<string, ToneName> = {
  critical: 'danger', high: 'danger', medium: 'warning', low: 'info', info: 'info',
}

// ── Skeletons ───────────────────────────────────────────────────────────────
// Structure-suggesting placeholders. A spinner says "wait"; a skeleton says
// "four stat tiles and a list are coming", which is the difference between
// waiting and knowing.

export function Skeleton({ w = '100%', h = 12, radius = 6, style }: {
  w?: number | string; h?: number | string; radius?: number; style?: React.CSSProperties
}) {
  const { c } = useTheme()
  const reduced = useReducedMotion()
  return (
    <div
      aria-hidden="true"
      style={{
        width: w, height: h, borderRadius: radius, background: c.surfaceMuted,
        // The shimmer is the only thing that distinguishes "loading" from
        // "empty box", so without motion we hold a slightly stronger fill.
        opacity: reduced ? 0.75 : undefined,
        animation: reduced ? undefined : 'clt-skeleton-pulse 1.4s ease-in-out infinite',
        ...style,
      }}
    />
  )
}

/** The four-tile KPI band, before it has anything to show. */
export function SkeletonTiles({ count = 4, columns = 2 }: { count?: number; columns?: number }) {
  const { c } = useTheme()
  return (
    <div className="auto-grid" style={{ '--cols': String(columns), '--col-min': '140px', '--grid-gap': '8px' } as React.CSSProperties}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          background: c.surfaceSubtle, border: `1px solid ${c.borderSubtle}`,
          borderRadius: 8, padding: '11px 13px',
        }}>
          <Skeleton w="55%" h={9} style={{ marginBottom: 8 }} />
          <Skeleton w="40%" h={18} />
        </div>
      ))}
    </div>
  )
}

/** A queue of rows, before the queue has loaded. */
export function SkeletonRows({ count = 4, height = 54 }: { count?: number; height?: number }) {
  const { c } = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          background: c.surfaceSubtle, border: `1px solid ${c.borderSubtle}`,
          borderRadius: 8, padding: '10px 12px', height,
          // Rows lower down are progressively fainter: the eye reads it as a
          // list continuing past the fold rather than four identical boxes.
          opacity: 1 - i * 0.16,
        }}>
          <Skeleton w="45%" h={10} style={{ marginBottom: 8 }} />
          <Skeleton w="72%" h={8} />
        </div>
      ))}
    </div>
  )
}

// ── Numbers that move ───────────────────────────────────────────────────────

/** Compact for display: 1,284 · 12.9K · 1.4M. Big standalone values keep the
 *  font's proportional figures — `tabular-nums` gives every digit the width of
 *  a zero, which makes a number like 121 look loose at display sizes. */
export function compact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`
  if (a >= 10_000) return `${(n / 1000).toFixed(a >= 100_000 ? 0 : 1)}K`
  return n.toLocaleString()
}

/**
 * A value that acknowledges its own change.
 *
 * On a shift-long screen the risk is not that an update is missed in the
 * moment — it is that nobody can tell whether the number they are looking at
 * moved thirty seconds ago or has been stuck for an hour. A single ~400ms
 * highlight on change answers that without becoming a distraction.
 */
export function LiveValue({ value, tone: toneName, size = 20, title }: {
  value: React.ReactNode
  tone?: ToneName
  size?: number
  title?: string
}) {
  const { c } = useTheme()
  const reduced = useReducedMotion()
  const t = toneName ? tone(c, toneName) : null
  const prev = useRef(value)
  const [bump, setBump] = useState(false)

  useEffect(() => {
    if (prev.current === value) return
    prev.current = value
    if (reduced) return
    setBump(true)
    const id = setTimeout(() => setBump(false), 420)
    return () => clearTimeout(id)
  }, [value, reduced])

  return (
    <span
      title={title}
      style={{
        fontSize: size, fontWeight: 800, lineHeight: 1,
        color: t ? t.text : c.textPrimary,
        // Deliberately NOT tabular: these are standalone display values.
        transition: reduced ? undefined : 'background-color 420ms ease-out',
        background: bump ? (t ? t.bg : c.surfaceMuted) : 'transparent',
        borderRadius: 4, padding: '0 3px', margin: '0 -3px',
      }}
    >
      {value}
    </span>
  )
}

/**
 * Direction + magnitude, never colour alone.
 *
 * `goodWhenUp` exists because direction and desirability are different
 * questions: more vans active is good, more vans off the road is not, and the
 * arrow must point the way the number went while the colour says whether that
 * is welcome.
 */
export function DeltaBadge({ delta, unit = '', goodWhenUp = true, title }: {
  delta: number | null | undefined
  unit?: string
  goodWhenUp?: boolean
  title?: string
}) {
  const { c } = useTheme()
  if (delta == null || Number.isNaN(delta)) return null
  const flat = Math.abs(delta) < 0.05
  const up = delta > 0
  const good = flat ? null : up === goodWhenUp
  const t = tone(c, good == null ? 'neutral' : good ? 'success' : 'danger')
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        fontSize: 10.5, fontWeight: 800, color: t.text,
        background: t.bg, border: `1px solid ${t.border}`,
        borderRadius: 20, padding: '1px 6px', whiteSpace: 'nowrap',
      }}
    >
      <Icon size={10} aria-hidden="true" />
      {flat ? 'flat' : `${up ? '+' : '−'}${compact(Math.abs(delta))}${unit}`}
    </span>
  )
}

/**
 * Twelve points of history in sixty pixels.
 *
 * No axes, no labels, no grid — a sparkline earns its space by being read in
 * peripheral vision, and anything that invites a second look defeats it. The
 * line is the de-emphasis step; only the current point wears the tone.
 */
export function Sparkline({ points, tone: toneName = 'info', w = 62, h = 18, label }: {
  points: number[]
  tone?: ToneName
  w?: number
  h?: number
  label?: string
}) {
  const { c } = useTheme()
  const t = tone(c, toneName)
  if (!points || points.length < 2) return <div style={{ width: w, height: h }} aria-hidden="true" />

  const lo = Math.min(...points)
  const hi = Math.max(...points)
  const span = hi - lo || 1
  const pad = 2
  const step = (w - pad * 2) / (points.length - 1)
  const y = (v: number) => pad + (h - pad * 2) * (1 - (v - lo) / span)
  const d = points.map((v, i) => `${i ? 'L' : 'M'}${(pad + i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const lastX = pad + (points.length - 1) * step
  const lastY = y(points[points.length - 1])

  return (
    <svg
      width={w} height={h} viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={label ?? `Trend, ${points.length} points, latest ${points[points.length - 1]}`}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <path d={d} fill="none" stroke={c.chartGrid} strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round" />
      {/* Only the leading edge carries the tone — the eye lands on "now". */}
      <path d={d} fill="none" stroke={t.solid} strokeWidth={2} strokeLinecap="round"
            strokeLinejoin="round" strokeDasharray={`${step * 1.2} ${w * 2}`}
            strokeDashoffset={-(lastX - step * 1.2 - pad)} opacity={0.95} />
      <circle cx={lastX} cy={lastY} r={2.6} fill={t.solid}
              stroke={c.surface} strokeWidth={1.5} />
    </svg>
  )
}

// ── Status, stated ──────────────────────────────────────────────────────────

const TONE_ICON: Record<ToneName, React.ElementType> = {
  success: Check, warning: AlertTriangle, danger: X,
  info: Info, ai: Info, neutral: Minus, accent: Info,
}

/**
 * A state badge that survives being printed in greyscale, viewed by a
 * colourblind operator, or rendered in forced-colors mode — because it always
 * carries an icon and a word, and colour is the third channel rather than the
 * only one.
 */
export function StatusBadge({ tone: toneName, children, icon, subtle = false }: {
  tone: ToneName
  children: React.ReactNode
  icon?: React.ElementType
  subtle?: boolean
}) {
  const { c } = useTheme()
  const t = tone(c, toneName)
  const Icon = icon ?? TONE_ICON[toneName]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 10.5, fontWeight: 800, letterSpacing: '0.02em',
      color: t.text, background: subtle ? 'transparent' : t.bg,
      border: `1px solid ${subtle ? 'transparent' : t.border}`,
      borderRadius: 20, padding: subtle ? 0 : '1px 7px',
      textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>
      <Icon size={10} aria-hidden="true" />
      {children}
    </span>
  )
}

/** A status dot that is not colour-alone: it carries a shape difference too,
 *  so the five van states stay distinguishable in greyscale. */
export function StatusDot({ tone: toneName, pulse = false, size = 8 }: {
  tone: ToneName; pulse?: boolean; size?: number
}) {
  const { c } = useTheme()
  const reduced = useReducedMotion()
  const t = tone(c, toneName)
  return (
    <span
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: '50%', background: t.solid,
        flexShrink: 0, display: 'inline-block',
        boxShadow: pulse ? `0 0 0 3px ${t.bg}` : undefined,
        animation: pulse && !reduced ? 'clt-live-pulse 2s ease-in-out infinite' : undefined,
      }}
    />
  )
}

// ── Stat tile ───────────────────────────────────────────────────────────────

/**
 * The stat tile contract: label · value · optional delta · optional trend.
 *
 * One tile answers one question. The label is sentence case with no trailing
 * colon, the value is the only thing at display size, and the delta names what
 * it is measured against — a number with no baseline is decoration.
 */
export function StatTile({
  label, value, tone: toneName = 'neutral', icon, delta, deltaUnit, goodWhenUp = true,
  trend, note, onClick, title, loading = false,
}: {
  label: string
  value: React.ReactNode
  tone?: ToneName
  icon?: React.ReactNode
  delta?: number | null
  deltaUnit?: string
  goodWhenUp?: boolean
  trend?: number[]
  note?: React.ReactNode
  onClick?: () => void
  title?: string
  loading?: boolean
}) {
  const { c } = useTheme()
  const t = tone(c, toneName)
  const interactive = !!onClick

  if (loading) {
    return (
      <div style={{
        background: c.surfaceSubtle, border: `1px solid ${c.borderSubtle}`,
        borderRadius: 8, padding: '11px 13px',
      }}>
        <Skeleton w="55%" h={9} style={{ marginBottom: 8 }} />
        <Skeleton w="40%" h={18} />
      </div>
    )
  }

  const body = (
    <>
      <div style={{
        fontSize: 11, color: c.textSecondary, marginBottom: 4,
        display: 'flex', alignItems: 'center', gap: 5, minWidth: 0,
      }}>
        {icon && <span style={{ color: t.text, flexShrink: 0, display: 'flex' }} aria-hidden="true">{icon}</span>}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <LiveValue value={value} tone={toneName === 'neutral' ? undefined : toneName} />
          {delta != null && <DeltaBadge delta={delta} unit={deltaUnit} goodWhenUp={goodWhenUp} />}
        </div>
        {trend && trend.length > 1 && <Sparkline points={trend} tone={toneName} />}
      </div>
      {note && (
        <div style={{ fontSize: 10.5, color: c.textMuted, marginTop: 3, lineHeight: 1.5 }}>{note}</div>
      )}
    </>
  )

  const style: React.CSSProperties = {
    background: toneName === 'neutral' ? c.surfaceSubtle : t.bg,
    border: `1px solid ${toneName === 'neutral' ? c.borderSubtle : t.border}`,
    borderRadius: 8, padding: '11px 13px', textAlign: 'left', width: '100%',
    cursor: interactive ? 'pointer' : 'default',
  }

  return interactive
    ? <button type="button" onClick={onClick} title={title} style={style}>{body}</button>
    : <div title={title} style={style}>{body}</div>
}

// ── Freshness ───────────────────────────────────────────────────────────────

function ageLabel(seconds: number): string {
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${Math.floor(seconds)}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

/**
 * How old is what I am looking at?
 *
 * The pages already had a websocket "Live / Offline" lamp, but a connected
 * socket is not the same claim as fresh data — the feed can be up while the
 * last snapshot is twenty minutes old, and that is precisely the state in which
 * an operator makes a confident wrong decision. This states the age out loud,
 * turns amber then red as it goes stale, and offers the manual refetch rather
 * than making somebody reload the page to be sure.
 */
export function FreshnessMeter({ lastRefresh, connected, onRefresh, refreshing = false, compactMode = false }: {
  lastRefresh?: string | null
  connected?: boolean
  onRefresh?: () => void
  refreshing?: boolean
  compactMode?: boolean
}) {
  const { c } = useTheme()
  const reduced = useReducedMotion()
  const [, force] = useState(0)

  // The age has to keep counting even when no new data arrives — that is the
  // whole point of it.
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 5000)
    return () => clearInterval(id)
  }, [])

  const ts = lastRefresh ? Date.parse(lastRefresh) : NaN
  const age = Number.isNaN(ts) ? null : Math.max(0, (Date.now() - ts) / 1000)
  const toneName: ToneName = !connected ? 'danger'
    : age == null ? 'neutral'
    : age > 900 ? 'danger' : age > 300 ? 'warning' : 'success'
  const t = tone(c, toneName)

  const text = !connected ? 'Feed offline'
    : age == null ? 'Awaiting feed'
    : `Updated ${ageLabel(age)}`

  return (
    <div
      // Announced politely: an operator using a screen reader should learn that
      // the feed went stale without being interrupted mid-sentence.
      role="status"
      aria-live="polite"
      aria-label={`Data freshness: ${text}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 11, fontWeight: 700, color: t.text,
        background: compactMode ? 'transparent' : t.bg,
        border: `1px solid ${compactMode ? 'transparent' : t.border}`,
        borderRadius: 20, padding: compactMode ? 0 : '2px 9px', whiteSpace: 'nowrap',
      }}
    >
      <StatusDot tone={toneName} pulse={connected && toneName === 'success'} size={7} />
      <span>{text}</span>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh now"
          title="Refresh now"
          style={{
            display: 'inline-flex', alignItems: 'center', background: 'none',
            border: 'none', padding: 0, marginLeft: 1, cursor: refreshing ? 'wait' : 'pointer',
            color: 'inherit', opacity: refreshing ? 0.6 : 1,
          }}
        >
          <RefreshCw
            size={11}
            style={{ animation: refreshing && !reduced ? 'clt-spin 900ms linear infinite' : undefined }}
          />
        </button>
      )}
    </div>
  )
}
