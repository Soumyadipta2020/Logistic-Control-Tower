import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { getKPIDef } from '../../lib/kpiDefinitions'
import { useTheme } from '../../hooks/useTheme'
import { ragTone } from '../../lib/colors'

const PANEL_W = 300
const PANEL_H_EST = 240

interface KPICardProps {
  label: string
  value: number | string
  unit?: string
  target?: number
  rag?: 'G' | 'A' | 'R'
  trend?: 'up' | 'down' | 'stable'
  trendLabel?: string
  tooltipKey?: string
  icon?: React.ElementType
  iconColor?: string
}

/** What a RAG letter actually means, spelled out for assistive tech. */
const RAG_MEANING = {
  G: 'On target',
  A: 'At risk',
  R: 'Breached',
} as const

/**
 * A single measure, its status, and — on hover or focus — its definition.
 *
 * ── WHY THE COLOUR CHANGED ────────────────────────────────────────────────────
 * This card used to pick its colour from a seven-hue rainbow indexed by grid
 * POSITION: `THEME_COLORS[index % 7]`. Two things were wrong with that.
 *
 *   1. The same KPI changed colour depending on where it happened to sit. Move a
 *      card, reorder a dashboard, hide one behind a permission check, and every
 *      card after it shifts hue. Colour that changes for reasons unrelated to
 *      the data is worse than no colour, because users read meaning into it.
 *   2. The rainbow spent red, amber and green on positions 4, 3 and 2. Those
 *      three colours already mean breached / at-risk / on-target everywhere else
 *      in this product, so a healthy KPI could render red purely for sitting
 *      fourth — actively contradicting its own RAG dot.
 *
 * Colour is now the card's status and nothing else, driven by `rag`, and status
 * is never carried by colour alone: the dot, the border, and an sr-only phrase
 * all say the same thing (SC 1.4.1).
 */
export function KPICard({ label, value, unit, target, rag, trend, trendLabel, tooltipKey, icon: Icon }: KPICardProps & { index?: number }) {
  const { c } = useTheme()
  // Tooltip is rendered through a portal with position:fixed so ancestor
  // overflow/stacking contexts can never clip it.
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const def = getKPIDef(tooltipKey ?? label)

  const tone = rag ? ragTone(c, rag) : null

  const trendIcon = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'
  const trendClass = trend === 'up' ? 'up' : trend === 'down' ? 'down' : ''

  function open() {
    if (!def || !cardRef.current) return
    const rect = cardRef.current.getBoundingClientRect()
    const above = rect.bottom + PANEL_H_EST + 10 > window.innerHeight && rect.top > PANEL_H_EST + 10
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - PANEL_W - 8)
    setPos({ top: above ? rect.top - 8 : rect.bottom + 8, left, above })
  }

  const close = () => setPos(null)

  const tooltipId = def ? `kpi-tip-${(tooltipKey ?? label).replace(/\W+/g, '-')}` : undefined

  return (
    <div
      ref={cardRef}
      className="kpi-card"
      // Drives the border rail and the icon tint from index.css, so the status
      // styling lives in one place instead of being recomputed inline per card.
      data-rag={rag}
      // Only focusable when there is something to reveal. A tabIndex on a card
      // with no tooltip would add a tab stop that does nothing.
      tabIndex={def ? 0 : undefined}
      // The definition panel is the accessible description of the card, so the
      // same content a mouse user gets on hover is announced on focus.
      aria-describedby={pos ? tooltipId : undefined}
      onFocus={open}
      onBlur={close}
      onMouseEnter={open}
      onMouseLeave={close}
      // Escape closes it without moving focus — the standard tooltip contract
      // (SC 1.4.13 Content on Hover or Focus).
      onKeyDown={(e) => { if (e.key === 'Escape' && pos) { e.stopPropagation(); close() } }}
    >
      <div className="kpi-header">
        {/* Icon chip. Decorative — the label beneath already names the measure. */}
        <span className="kpi-icon" aria-hidden="true">
          {Icon ? <Icon size={16} strokeWidth={1.8} /> : <span className="kpi-rag" />}
        </span>

        {rag && (
          <span className="kpi-header-status">
            <span className={`kpi-rag ${rag}`} aria-hidden="true" />
            {/* The dot is a colour; this is what the colour means. */}
            <span className="sr-only">Status: {RAG_MEANING[rag]}.</span>
          </span>
        )}
      </div>

      <div>
        <div className="kpi-value-row">
          <span className="kpi-value">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </span>
          {unit && <span className="kpi-unit">{unit}</span>}
        </div>
        <div className="kpi-label">{label}</div>
        {target !== undefined && (
          <span className="sr-only">Target: {target}{unit ? ` ${unit}` : ''}.</span>
        )}
      </div>

      {trend && (
        <div className={`kpi-trend ${trendClass}`}>
          {/* The arrow carries direction independently of the colour. */}
          <span aria-hidden="true">{trendIcon}</span>{' '}
          {trendLabel || trend}
        </div>
      )}

      {pos && def && createPortal(
        <div
          id={tooltipId}
          role="tooltip"
          className="kpi-tooltip"
          style={{
            top: pos.top,
            left: pos.left,
            transform: pos.above ? 'translateY(-100%)' : undefined,
          }}
        >
          <div className="kpi-tooltip-title">{label}</div>

          <div
            className="kpi-tooltip-figure"
            style={tone
              ? { background: tone.bg, borderColor: tone.border }
              : { background: c.surfaceSubtle, borderColor: c.border }}
          >
            <span
              className="kpi-tooltip-value"
              // Uses the tone's *text* colour, not its saturated fill. The fill
              // (#10B981 / #F59E0B) sits at 2.1–2.5:1 on a light surface; the
              // text step is ≥4.5:1 on its own container.
              style={{ color: tone ? tone.text : c.textPrimary }}
            >
              {typeof value === 'number' ? value.toLocaleString() : value}
              {unit ? <span className="kpi-tooltip-unit"> {unit}</span> : null}
            </span>
            {target !== undefined && (
              <span className="kpi-tooltip-target">
                / {target}{unit ? ` ${unit}` : ''} target
              </span>
            )}
          </div>

          <p className="kpi-tooltip-meaning">{def.meaning}</p>

          <p className="kpi-tooltip-how">
            <span className="kpi-tooltip-how-label">How: </span>
            {def.howCalculated}
          </p>

          {def.benchmark && (
            <p className="kpi-tooltip-benchmark">{def.benchmark}</p>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
