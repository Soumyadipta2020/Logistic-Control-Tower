import { Menu } from 'lucide-react'
import { useStore } from '../../store/useStore'

interface Props {
  title: string
  subtitle?: string
  actions?: React.ReactNode
}

/**
 * The page's identity band — and the only <h1> on any screen.
 *
 * It was previously a stack of <div>s, which meant the app shipped with no
 * heading structure at all: a screen-reader user landing on a page had no way
 * to find out where they were short of reading it top to bottom, and the
 * "jump to heading" navigation every screen reader offers did nothing (WCAG
 * 2.4.6 / 1.3.1). Rendering the real element costs nothing visually — the
 * .page-title class carries the same look it always did.
 */
export function PageHeader({ title, subtitle, actions }: Props) {
  const wsConnected = useStore((s) => s.wsConnected)
  const navOpen = useStore((s) => s.navOpen)
  const setNavOpen = useStore((s) => s.setNavOpen)

  return (
    <header className="page-header">
      {/*
        Opens the navigation drawer below 768px. CSS hides it above that width,
        where the sidebar is permanently on screen — but it stays in the DOM
        rather than being conditionally rendered, so the aria-controls
        relationship and the tab order do not change as the window is resized.
      */}
      <button
        type="button"
        className="nav-toggle"
        onClick={() => setNavOpen(!navOpen)}
        aria-expanded={navOpen}
        aria-label={navOpen ? 'Close navigation menu' : 'Open navigation menu'}
      >
        <Menu size={18} strokeWidth={2} aria-hidden="true" />
      </button>

      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>

      <div className="header-actions">
        {/*
          Connection state. The dot is decoration — the adjacent word carries
          the meaning for sighted users, and the sr-only sentence spells out
          what "LIVE" and "POLLING" actually imply, which the two-word label
          alone does not (SC 1.4.1, 3.3.2).

          aria-live="polite" so a drop to polling is announced when it happens,
          rather than only being discovered by someone re-reading the header.
        */}
        <div
          className={`live-indicator${wsConnected ? '' : ' is-polling'}`}
          aria-live="polite"
        >
          <span className="live-dot" aria-hidden="true" />
          <span aria-hidden="true">{wsConnected ? 'LIVE' : 'POLLING'}</span>
          <span className="sr-only">
            {wsConnected
              ? 'Connected. Data updates in real time.'
              : 'Real-time connection unavailable. Data refreshes every 60 seconds.'}
          </span>
        </div>

        <div className="last-refresh" aria-hidden="true">Refreshes every 60s</div>
        {actions}
      </div>
    </header>
  )
}
