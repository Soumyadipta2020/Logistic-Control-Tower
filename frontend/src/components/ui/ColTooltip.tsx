import { useState, useRef } from 'react'
import { getKPIDef } from '../../lib/kpiDefinitions'
import { useTheme } from '../../hooks/useTheme'

const PANEL_W = 295

interface ColTooltipProps {
  label: string
  lookupKey?: string
}

export function ColTooltip({ label, lookupKey }: ColTooltipProps) {
  const { c } = useTheme()
  const [show, setShow] = useState(false)
  const [above, setAbove] = useState(false)
  const [side, setSide] = useState<'left' | 'right'>('left')
  const ref = useRef<HTMLSpanElement>(null)
  const def = getKPIDef(lookupKey ?? label)

  if (!def) return <>{label}</>

  function handleEnter() {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setAbove(rect.bottom + 260 > window.innerHeight)
      setSide(rect.left + PANEL_W > window.innerWidth - 8 ? 'right' : 'left')
    }
    setShow(true)
  }

  return (
    <span
      ref={ref}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        whiteSpace: 'nowrap',
        cursor: 'default',
        userSelect: 'none',
      }}
      onMouseEnter={handleEnter}
      onMouseLeave={() => setShow(false)}
    >
      {label}

      {/* ⓘ icon */}
      <span style={{
        width: 13, height: 13, borderRadius: '50%',
        background: c.chipBg,
        border: `1px solid ${c.chipBorder}`,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 800, color: c.chipText,
        lineHeight: 1, flexShrink: 0,
        opacity: 0.85,
      }}>i</span>

      {show && (
        <div style={{
          position: 'absolute',
          [above ? 'bottom' : 'top']: 'calc(100% + 8px)',
          ...(side === 'left' ? { left: 0 } : { right: 0 }),
          width: PANEL_W,
          background: c.surface,
          border: `1px solid ${c.border}`,
          borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          padding: '12px 14px',
          zIndex: 2000,
          pointerEvents: 'none',
          textTransform: 'none',
          fontWeight: 400,
          letterSpacing: 'normal',
          textAlign: 'left',
          whiteSpace: 'normal',
        }}>
          {/* Arrow */}
          <div style={{
            position: 'absolute',
            [above ? 'bottom' : 'top']: -6,
            ...(side === 'left' ? { left: 14 } : { right: 14 }),
            width: 10, height: 10,
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRight: 'none',
            borderBottom: above ? 'none' : undefined,
            borderTop: above ? undefined : 'none',
            transform: above ? 'rotate(-45deg)' : 'rotate(135deg)',
          }} />

          <div style={{ fontSize: 11, fontWeight: 800, color: c.textPrimary, marginBottom: 5, lineHeight: 1.3 }}>
            {label}
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
              borderRadius: 5, padding: '4px 8px', lineHeight: 1.5, marginTop: 2,
            }}>
              {def.benchmark}
            </div>
          )}
        </div>
      )}
    </span>
  )
}
