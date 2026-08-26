// Shared primitives for the map pages' right-hand detail panel
// (Live Visibility, Transport Control). Both pages had their own
// pixel-identical copies of these — kept here once so the two panels can't
// drift apart the way they had (420px vs 400px panel, two different
// hand-rolled detail headers, etc).

import { ChevronLeft, ChevronRight } from 'lucide-react'

export function Divider() {
  return <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.15)', flexShrink: 0 }} />
}

export function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: 10, marginTop: 4,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em',
        color: 'var(--clt-grey-500)',
      }}>
        {children}
      </div>
      {right}
    </div>
  )
}

export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 20,
      background: 'var(--clt-grey-100)', color: 'var(--clt-grey-700)',
    }}>
      {children}
    </span>
  )
}

/** "Nothing here" — a filtered-to-zero list or a satisfied check. */
export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      textAlign: 'center', padding: '12px 0', background: 'var(--clt-grey-50)',
      borderRadius: 8, fontSize: 11, color: 'var(--clt-grey-400)',
    }}>
      {children}
    </div>
  )
}

/**
 * A sub-heading *inside* an expanded card ("Consignment", "Tracking").
 *
 * Same type treatment as `SectionLabel` but without its outer margins, because
 * a label nested in a card is not a label for a whole panel section. The two had
 * been written out longhand at every use, which is how "Options" on one card
 * came to be a `<span>` in a flex row and a bare `<div>` on the next.
 */
export function CardSubLabel({ children, style }: {
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 800, textTransform: 'uppercase',
      letterSpacing: '0.08em', color: 'var(--text-tertiary)', marginBottom: 6,
      ...style,
    }}>
      {children}
    </div>
  )
}

/**
 * The tertiary CTA — "take me to the related record".
 *
 * There is exactly one of these looks now. Across the two map workspaces the
 * same idea had been written five different ways: weight 600 next to weight 700,
 * a "→" text glyph next to a <ChevronRight> icon (in the same flex row, side by
 * side), and the identical action — "Open {engineer}'s van" — rendered once as a
 * bare inline link and once as a full-width bordered button.
 *
 * It also fixes the hit area. Every one of them was `padding: 0` around 11px
 * text, giving a target roughly 11px tall — the same problem this codebase
 * already called out and fixed for its scrollbars ("nowhere near SC 2.5.8").
 * The padding here brings the target to 24px while negative margin keeps the
 * label optically flush with whatever it sits beside.
 */
export function CardLink({ onClick, children, title, align = 'right' }: {
  onClick: () => void
  children: React.ReactNode
  title?: string
  /** `right` pulls the trailing edge flush; `left` the leading edge. */
  align?: 'left' | 'right'
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={title}
      className="clt-card-link"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 2,
        fontSize: 11, fontWeight: 700, lineHeight: 1,
        color: 'var(--accent-text)', background: 'none', border: 'none',
        cursor: 'pointer', borderRadius: 5, whiteSpace: 'nowrap',
        // 24px target from 11px text, without pushing the label off its edge.
        padding: '6px 7px',
        marginRight: align === 'right' ? -7 : 0,
        marginLeft: align === 'left' ? -7 : 0,
      }}
    >
      {children}
      <ChevronRight size={12} aria-hidden="true" />
    </button>
  )
}

/**
 * The "OPTIONS ————— [go to the record]" row that opens every expanded alert
 * card. Three of the four cards already had this shape; the carrier card was
 * the odd one out, dropping its links at the bottom-left after the option list
 * instead — which is what made the same gesture live in two different corners
 * depending on which queue you happened to be working.
 */
export function OptionsHeader({ label = 'Options', children }: {
  label?: string
  children?: React.ReactNode
}) {
  return (
    <div style={{
      margin: '9px 0 8px', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', gap: 8, minHeight: 24,
    }}>
      <span style={{
        fontSize: 11, fontWeight: 800, textTransform: 'uppercase',
        letterSpacing: '0.08em', color: 'var(--text-tertiary)',
      }}>
        {label}
      </span>
      {children && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          {children}
        </div>
      )}
    </div>
  )
}

/** Header for a drill-in detail view: back button + optional status badge. */
export function DetailHeader({ onBack, children }: { onBack: () => void; children?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
      borderBottom: '1px solid var(--clt-grey-200)', background: 'var(--clt-grey-50)', flexShrink: 0,
    }}>
      <button onClick={onBack} style={{
        background: 'none', border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 3, fontSize: 12,
        color: 'var(--clt-grey-500)', padding: '3px 6px', borderRadius: 5,
      }}>
        <ChevronLeft size={13} /> Back
      </button>
      <div style={{ flex: 1 }} />
      {children}
    </div>
  )
}

/** Status badge for a DetailHeader — one look for every detail view's state pill. */
export function DetailBadge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 800, textTransform: 'uppercase', padding: '2px 9px',
      borderRadius: 20, background: tone + '1e', color: tone,
    }}>
      {children}
    </span>
  )
}
