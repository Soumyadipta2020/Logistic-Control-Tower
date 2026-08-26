import { useState, useRef, useId, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { getKPIDef } from '../../lib/kpiDefinitions'
import { useTheme } from '../../hooks/useTheme'

const PANEL_W = 290
const PANEL_H_EST = 200 // used only to decide above/below placement

/**
 * MetricTip — wrap any metric element; a rich helper tooltip appears when the
 * metric itself is hovered or keyboard-focused. No ⓘ icon.
 *
 * Rendered through a portal with position:fixed so no ancestor overflow,
 * transform or stacking context can ever clip it (the failure mode of the old
 * inline-absolute tooltips). Keyboard-accessible: focusable, aria-describedby,
 * Escape dismisses.
 *
 * `onActivate` makes the same element the drill-down as well as the tooltip
 * target. That matters on the Executive Dashboard, where every hero KPI both
 * explains itself and opens the module that owns it: wrapping a separate button
 * inside would put two tab stops on one card, sixteen across the row.
 */
export function MetricTip({ label, title, block, onActivate, activateLabel, children }: {
  label: string            // key into KPI_DEFINITIONS (display label or snake_case)
  title?: string           // heading override; defaults to `label`
  block?: boolean          // block-level wrapper (grid/flex children); default inline
  onActivate?: () => void  // makes the wrapper a button (click / Enter / Space)
  activateLabel?: string   // accessible name for that button
  children: React.ReactNode
}) {
  const { c } = useTheme()
  const tipId = useId()
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null)
  const def = getKPIDef(label)

  const show = useCallback(() => {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    const above = r.bottom + PANEL_H_EST + 10 > window.innerHeight && r.top > PANEL_H_EST + 10
    // clamp horizontally so the panel always stays inside the viewport
    const left = Math.min(Math.max(8, r.left), window.innerWidth - PANEL_W - 8)
    setPos({ top: above ? r.top - 7 : r.bottom + 7, left, above })
  }, [])
  const hide = useCallback(() => setPos(null), [])

  // With nothing to explain AND nothing to open, the wrapper would be a tab stop
  // that does nothing — so it isn't rendered at all.
  if (!def && !onActivate) return <>{children}</>

  return (
    <span
      ref={ref}
      tabIndex={0}
      role={onActivate ? 'button' : undefined}
      aria-label={onActivate ? activateLabel : undefined}
      aria-describedby={pos ? tipId : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { hide(); return }
        // Escape dismisses the tooltip without moving focus (SC 1.4.13); Enter and
        // Space are the button contract the role above promises.
        if (onActivate && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onActivate()
        }
      }}
      style={{
        display: block ? 'block' : 'inline-flex',
        minWidth: 0,
        cursor: onActivate ? 'pointer' : 'help',
      }}
    >
      {children}
      {pos && def && createPortal(
        <div
          id={tipId}
          role="tooltip"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            transform: pos.above ? 'translateY(-100%)' : undefined,
            width: PANEL_W,
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRadius: 10,
            boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
            padding: '12px 14px',
            zIndex: 3000,
            pointerEvents: 'none',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 800, color: c.textPrimary, marginBottom: 5, lineHeight: 1.3 }}>
            {title ?? label}
          </div>
          <div style={{ fontSize: 11, color: c.textSecondary, lineHeight: 1.6, marginBottom: def.howCalculated ? 7 : 0 }}>
            {def.meaning}
          </div>
          {def.howCalculated && (
            <div style={{ fontSize: 11, color: c.textMuted, lineHeight: 1.5, marginBottom: def.benchmark ? 6 : 0 }}>
              <span style={{ fontWeight: 700, color: c.textSecondary }}>How: </span>
              {def.howCalculated}
            </div>
          )}
          {def.benchmark && (
            <div style={{
              fontSize: 11, color: c.info.text,
              background: c.info.bg,
              border: `1px solid ${c.info.border}`,
              borderRadius: 5, padding: '4px 8px', lineHeight: 1.5,
            }}>
              {def.benchmark}
            </div>
          )}
        </div>,
        document.body
      )}
    </span>
  )
}
