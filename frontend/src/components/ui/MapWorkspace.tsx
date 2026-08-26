/**
 * Shell pieces shared by the two map workspaces — Transport Control and the
 * Live Visibility Hub.
 *
 * Both pages are the same shape: a full-bleed map on the left, a tabbed working
 * panel on the right, a dense status strip across the top. They had that shape
 * copied twice, which is how they ended up with a hardcoded light basemap, a
 * fixed 40% panel nobody could widen, and a tab bar built from plain buttons
 * that no screen reader could announce as tabs.
 *
 * The three things fixed here are the three that matter for a screen somebody
 * sits in front of all day:
 *
 *   1. THE MAP MATCHES THE ROOM. Dark mode was already hand-tuned throughout
 *      this app, and then both pages pinned CARTO's `light_all` tiles — so a
 *      night-shift dispatcher on the dark theme got a floodlit white map in the
 *      middle of an otherwise dark console. The basemap now follows the theme.
 *
 *   2. THE PANEL IS THE OPERATOR'S TO SIZE. Reading a carrier consignment and
 *      watching the fleet spread across a region want opposite splits. The
 *      divider drags, remembers, and — because a drag target is useless to
 *      anyone who cannot drag — moves with the arrow keys too.
 *
 *   3. THE TABS ARE TABS. Real `tablist` / `tab` / `tabpanel` semantics with
 *      arrow-key navigation, so the panel is operable without a mouse.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTheme } from '../../hooks/useTheme'

// ── Basemap ─────────────────────────────────────────────────────────────────
// CARTO's two matched basemaps. Same geometry and labelling, different ink, so
// switching between them does not move a single road.

export const BASEMAP = {
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
  },
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
  },
} as const

/** The tile set for the active theme, plus a key that forces Leaflet to swap
 *  layers cleanly when the theme changes rather than blending two rasters. */
export function useBasemap() {
  const { theme } = useTheme()
  const dark = theme === 'dark'
  return { ...(dark ? BASEMAP.dark : BASEMAP.light), key: dark ? 'dark' : 'light', isDark: dark }
}

// ── Resizable panel ─────────────────────────────────────────────────────────

const MIN_PCT = 26
const MAX_PCT = 62

/**
 * A draggable split that remembers where it was left.
 *
 * Persisted per page key, so somebody who works the carrier queue on a wide
 * panel and the map on a narrow one does not re-drag it every morning.
 */
export function useResizablePanel(storageKey: string, initial = 40) {
  const [pct, setPct] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return Number.isFinite(saved) && saved >= MIN_PCT && saved <= MAX_PCT ? saved : initial
  })
  const [dragging, setDragging] = useState(false)
  const frame = useRef<HTMLDivElement | null>(null)

  useEffect(() => { localStorage.setItem(storageKey, String(Math.round(pct))) }, [pct, storageKey])

  const apply = useCallback((clientX: number) => {
    const box = frame.current?.getBoundingClientRect()
    if (!box || box.width === 0) return
    const next = ((box.right - clientX) / box.width) * 100
    setPct(Math.min(MAX_PCT, Math.max(MIN_PCT, next)))
  }, [])

  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => { e.preventDefault(); apply(e.clientX) }
    const up = () => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    // While dragging, the whole window is the drag surface — without this the
    // pointer picks up text selection and map panning on the way past.
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
    }
  }, [dragging, apply])

  /** The divider. Focusable and arrow-key operable — a resize you can only
   *  perform by dragging is a resize some people simply cannot perform. */
  const handleProps = {
    className: 'clt-resize-handle',
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-label': 'Resize the working panel',
    'aria-valuenow': Math.round(pct),
    'aria-valuemin': MIN_PCT,
    'aria-valuemax': MAX_PCT,
    tabIndex: 0,
    'data-dragging': dragging ? 'true' : undefined,
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); setDragging(true) },
    onDoubleClick: () => setPct(initial),
    onKeyDown: (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 8 : 2
      if (e.key === 'ArrowLeft') { e.preventDefault(); setPct(p => Math.min(MAX_PCT, p + step)) }
      if (e.key === 'ArrowRight') { e.preventDefault(); setPct(p => Math.max(MIN_PCT, p - step)) }
      if (e.key === 'Home') { e.preventDefault(); setPct(MAX_PCT) }
      if (e.key === 'End') { e.preventDefault(); setPct(MIN_PCT) }
      if (e.key === 'Enter') { e.preventDefault(); setPct(initial) }
    },
  }

  return { pct, frameRef: frame, handleProps, dragging, reset: () => setPct(initial) }
}

// ── Tabs ────────────────────────────────────────────────────────────────────

export interface PanelTab<K extends string> {
  key: K
  label: string
  /** Rendered as a count pill. Zero and null both render nothing. */
  count?: number | null
  /** Tone for the count pill — a queue that needs working reads danger. */
  tone?: 'danger' | 'warning' | 'neutral'
}

/**
 * An honest tablist.
 *
 * Roving tabindex plus arrow keys is the WAI-ARIA authoring-practice pattern:
 * one stop in the page tab order for the whole set, then left/right within it.
 * The counts are `aria-label`led in words because "Routes 4" read aloud as two
 * bare numbers tells you nothing.
 */
export function PanelTabs<K extends string>({ tabs, active, onChange, idPrefix }: {
  tabs: PanelTab<K>[]
  active: K
  onChange: (k: K) => void
  idPrefix: string
}) {
  const { c } = useTheme()
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  const move = (dir: 1 | -1) => {
    const i = tabs.findIndex(t => t.key === active)
    const next = tabs[(i + dir + tabs.length) % tabs.length]
    onChange(next.key)
    refs.current[next.key]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label="Working panel sections"
      style={{ display: 'flex', flexShrink: 0, borderBottom: `1px solid ${c.border}` }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); move(1) }
        if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1) }
        if (e.key === 'Home') { e.preventDefault(); onChange(tabs[0].key); refs.current[tabs[0].key]?.focus() }
        if (e.key === 'End') { e.preventDefault(); const l = tabs[tabs.length - 1]; onChange(l.key); refs.current[l.key]?.focus() }
      }}
    >
      {tabs.map(({ key, label, count, tone = 'danger' }) => {
        const on = active === key
        const pill = tone === 'warning' ? c.warning : tone === 'neutral' ? c.neutral : c.danger
        return (
          <button
            key={key}
            ref={el => { refs.current[key] = el }}
            role="tab"
            id={`${idPrefix}-tab-${key}`}
            aria-selected={on}
            aria-controls={`${idPrefix}-panel-${key}`}
            // Roving tabindex: the set is one stop, not five.
            tabIndex={on ? 0 : -1}
            aria-label={count ? `${label}, ${count} needing attention` : label}
            onClick={() => onChange(key)}
            style={{
              flex: 1, minWidth: 0, padding: '11px 2px', fontSize: 11, fontWeight: 700,
              border: 'none', cursor: 'pointer',
              background: on ? c.surface : c.surfaceSubtle,
              color: on ? c.accentText : c.textSecondary,
              borderBottom: `2px solid ${on ? c.accentSolid : 'transparent'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
            {count != null && count > 0 && (
              <span aria-hidden="true" style={{
                fontSize: 10.5, fontWeight: 900, minWidth: 15, height: 15, borderRadius: 8,
                background: pill.solid, color: pill.onSolid, display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center', padding: '0 4px', flexShrink: 0,
              }}>{count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── Keyboard ────────────────────────────────────────────────────────────────

/**
 * Page-level shortcuts, suppressed while the operator is typing.
 *
 * The guard matters more than the bindings: a dispatcher searching for a
 * registration must be able to type "e" without the page switching tabs
 * underneath them.
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  const ref = useRef(map)
  ref.current = map
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const typing = !!el && (
        el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
        el.isContentEditable)
      // Escape is the one key that must work from inside a field — it is how
      // you get out of the field.
      if (typing && e.key !== 'Escape') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const fn = ref.current[e.key]
      if (fn) fn(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

/** The "press ? for keys" affordance — shortcuts nobody can discover are
 *  shortcuts nobody uses. */
export function ShortcutHint({ items }: { items: [string, string][] }) {
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  useHotkeys({ '?': () => setOpen(o => !o), Escape: () => setOpen(false) })
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Show keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        style={{
          background: 'none', border: `1px solid ${c.borderStrong}`, color: c.textSecondary,
          borderRadius: 5, fontSize: 10, fontWeight: 800, width: 18, height: 18,
          cursor: 'pointer', lineHeight: 1, flexShrink: 0,
        }}
      >?</button>
    )
  }
  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      style={{
        position: 'absolute', top: 44, right: 14, zIndex: 900,
        background: c.surface, border: `1px solid ${c.border}`, borderRadius: 10,
        boxShadow: c.elevation3, padding: '12px 14px', minWidth: 240,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: c.textSecondary }}>
          Keyboard
        </span>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: c.textMuted, fontSize: 14, lineHeight: 1 }}>×</button>
      </div>
      {items.map(([k, what]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, fontSize: 11, padding: '3px 0', color: c.textSecondary }}>
          <kbd style={{
            fontFamily: 'inherit', fontSize: 10, fontWeight: 800, background: c.surfaceMuted,
            border: `1px solid ${c.border}`, borderRadius: 4, padding: '1px 6px', color: c.textPrimary,
          }}>{k}</kbd>
          <span style={{ textAlign: 'right' }}>{what}</span>
        </div>
      ))}
    </div>
  )
}
