// Shared rendering for the operational resolution layer.
//
// Four different alert families (van stock, pre-8AM locker misses, third-party
// carrier delays, arrival risk) all answer the same question — "what can I
// actually do about this?" — so they share one presentation: the option, what it
// costs, what it does to the clock, and where it is unavailable, why.
//
// An option nobody can compare is an option nobody can choose, so every row
// shows its price and its consequence rather than just its name.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronRight, Clock, PoundSterling, Sparkles, Ban, Timer, Activity, Lock } from 'lucide-react'
import { useTheme } from '../../hooks/useTheme'
import { useStore } from '../../store/useStore'
import { fetchStateEngine, fetchActionsToday, type ResolutionOption } from '../../lib/api'

/**
 * Severity as a filled mark — map pins, meter fills, the dot on a card edge.
 * These are the saturated `solid` steps and are identical in both themes,
 * because a mark on a surface is not text on a surface.
 */
export const SEVERITY_COLOR: Record<string, string> = {
  critical: '#EF4444', high: '#F97316', medium: '#F59E0B', low: '#3B82F6', opportunity: '#10B981',
}

/** Severity as a tone name, for anything that renders INK. */
export const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'info' | 'success' | 'neutral'> = {
  critical: 'danger', high: 'danger', medium: 'warning', low: 'info', opportunity: 'success',
}

/**
 * The severity pill reads as text, so it takes the theme's text step rather
 * than the mark colour. Painted with the raw `#EF4444` it sat at roughly 3.3:1
 * on the dark surface; the `danger.text` token it now uses is 9.4:1. The word
 * itself is the primary channel — colour is the second, never the only one.
 */
export function SeverityPill({ severity }: { severity: string }) {
  const { c } = useTheme()
  const t = c[SEVERITY_TONE[severity] ?? 'neutral']
  return (
    <span style={{
      fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
      padding: '2px 7px', borderRadius: 4,
      background: t.bg, color: t.text, border: `1px solid ${t.border}`,
    }}>
      {severity}
    </span>
  )
}

/** "Updates every 5m" — the cadence this panel's data actually moves at. */
export function FeedBadge({ label, interval }: { label: string; interval: string }) {
  return (
    <span
      title={`${label} refreshes every ${interval} — the rate its source system publishes at`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700,
        color: 'var(--clt-grey-400)', border: '1px solid var(--clt-grey-200)',
        borderRadius: 10, padding: '1px 7px', whiteSpace: 'nowrap',
      }}
    >
      <Timer size={9} /> {interval}
    </span>
  )
}

/** A resolved alert's outcome, shown in place of the option list. */
export function ResolutionOutcome({ resolution }: { resolution: any }) {
  const { c } = useTheme()
  if (!resolution) return null
  return (
    <div style={{
      background: c.success.bg, border: `1px solid ${c.success.border}`, borderRadius: 8,
      padding: '9px 11px', display: 'flex', gap: 8, alignItems: 'flex-start',
    }}>
      <Check size={14} color="#10B981" style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: c.success.text }}>{resolution.label}</div>
        <div style={{ fontSize: 11, color: c.textSecondary, marginTop: 2, lineHeight: 1.5 }}>
          {resolution.summary}
        </div>
        <div style={{ fontSize: 11, color: c.textMuted, marginTop: 3 }}>
          {resolution.by} · {new Date(resolution.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          {resolution.cost_gbp > 0 ? ` · £${resolution.cost_gbp.toFixed(2)}` : ' · no cost'}
        </div>
      </div>
    </div>
  )
}

/**
 * The option list for one alert. `onApply` receives the chosen action key.
 * Options arrive pre-ranked by the engine (available → recommended → fastest).
 */
export function OptionList({
  options, onApply, pending, disabled,
}: {
  options: ResolutionOption[]
  onApply: (action: string) => void
  pending?: string | null
  disabled?: boolean
}) {
  const { c } = useTheme()
  const [expanded, setExpanded] = useState<string | null>(
    options.find(o => o.recommended && o.available)?.action ?? null)

  if (!options?.length) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {options.map((o) => {
        const isOpen = expanded === o.action
        const busy = pending === o.action
        const tone = !o.available ? c.textMuted : o.recommended ? '#10B981' : 'var(--clt-blue)'
        return (
          <div
            key={o.action}
            style={{
              border: `1px solid ${!o.available ? c.borderSubtle : o.recommended ? '#10B98155' : c.border}`,
              background: !o.available ? c.surfaceSubtle : o.recommended ? '#10B9810d' : c.surface,
              borderRadius: 8, overflow: 'hidden', opacity: o.available ? 1 : 0.62,
            }}
          >
            <button
              onClick={() => setExpanded(isOpen ? null : o.action)}
              style={{
                width: '100%', textAlign: 'left', background: 'none', border: 'none',
                padding: '9px 11px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'flex-start',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: o.available ? c.textPrimary : c.textMuted }}>
                    {o.label}
                  </span>
                  {o.recommended && o.available && (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 800,
                      textTransform: 'uppercase', letterSpacing: '0.05em', padding: '1px 6px',
                      borderRadius: 4, background: '#10B98122', color: 'var(--status-success-text)',
                    }}>
                      <Sparkles size={8} /> Recommended
                    </span>
                  )}
                  {o.autonomy === 'human' && o.available && (
                    <span
                      title="Policy requires a human decision — ATLAS may prepare it but never execute it"
                      style={{
                        fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
                        padding: '1px 6px', borderRadius: 4, background: '#8B5CF61e', color: 'var(--status-ai-text)',
                      }}
                    >
                      Approval
                    </span>
                  )}
                  {!o.available && <Ban size={10} color={c.textMuted} />}
                </div>
                <div style={{ fontSize: 11, color: c.textSecondary, marginTop: 2, lineHeight: 1.45 }}>
                  {o.available ? o.blurb : o.unavailable_reason || o.blurb}
                </div>
                {o.available && (
                  <div style={{ display: 'flex', gap: 9, marginTop: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                    {o.eta_mins != null && (
                      <Metric icon={<Clock size={9} />}
                        value={o.eta_mins < 0 ? `−${Math.abs(o.eta_mins)} min` : `+${o.eta_mins} min`}
                        tone={o.eta_mins < 0 ? '#10B981' : '#F59E0B'} />
                    )}
                    <Metric icon={<PoundSterling size={9} />}
                      value={o.cost_gbp > 0 ? o.cost_gbp.toFixed(2) : 'no cost'}
                      tone={o.cost_gbp > 60 ? '#F97316' : c.textSecondary} />
                    {o.sla_impact && (
                      <span style={{ fontSize: 11, color: c.textMuted, fontStyle: 'italic' }}>{o.sla_impact}</span>
                    )}
                    <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: tone }}>
                      {o.confidence}%
                    </span>
                  </div>
                )}
              </div>
              <ChevronRight
                size={13}
                color={c.textMuted}
                style={{ flexShrink: 0, marginTop: 2, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}
              />
            </button>

            {isOpen && (
              <div style={{ padding: '0 11px 10px', borderTop: `1px solid ${c.borderSubtle}` }}>
                <div style={{ fontSize: 11, color: c.textSecondary, lineHeight: 1.55, marginTop: 8 }}>
                  {o.detail}
                </div>
                {o.consequence && (
                  <div style={{ fontSize: 11, color: c.textMuted, lineHeight: 1.5, marginTop: 5, fontStyle: 'italic' }}>
                    Trade-off: {o.consequence}
                  </div>
                )}
                {o.available && (
                  <button
                    onClick={() => onApply(o.action)}
                    disabled={busy || disabled}
                    style={{
                      marginTop: 9, width: '100%', padding: '7px 10px', borderRadius: 6,
                      fontSize: 11.5, fontWeight: 700, cursor: busy || disabled ? 'default' : 'pointer',
                      border: 'none', color: '#fff',
                      background: o.recommended ? '#059669' : 'var(--clt-blue)',
                      opacity: busy || disabled ? 0.6 : 1,
                    }}
                  >
                    {busy ? 'Applying…' : o.autonomy === 'human' ? `Approve & apply — ${o.label}` : `Apply — ${o.label}`}
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Metric({ icon, value, tone }: { icon: React.ReactNode; value: string; tone: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700, color: tone }}>
      {icon}{value}
    </span>
  )
}

/**
 * The state engine's own readout, for the dark status bars.
 *
 * Two questions an operator asks about live data and normally cannot answer:
 * "why did this number change / not change?" and "did what I just did stick, or
 * has the simulation already overwritten it?" The cadence table answers the
 * first; the hold count answers the second.
 */
export function StateEngineBadge() {
  const [open, setOpen] = useState(false)
  const { c } = useTheme()
  const { data } = useQuery({
    queryKey: ['state-engine'],
    queryFn: fetchStateEngine,
    refetchInterval: open ? 10_000 : 60_000,
  })
  if (!data) return null
  const holds = data.holds_active ?? 0

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        title="How often each parameter family updates, and what is currently pinned against redraw"
        style={{
          display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700,
          background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.13)',
          borderRadius: 6, padding: '2px 8px', cursor: 'pointer', color: 'rgba(255,255,255,0.6)',
        }}
      >
        <Activity size={11} />
        Feeds
        {holds > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--status-success-text)' }}>
            <Lock size={9} />{holds}
          </span>
        )}
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 800 }} />
          <div style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 801,
            width: 340, maxHeight: 420, overflowY: 'auto',
            background: c.surface, border: `1px solid ${c.border}`, borderRadius: 10,
            boxShadow: '0 12px 32px rgba(0,0,0,0.24)', padding: 13,
          }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: c.textPrimary, marginBottom: 4 }}>
              State engine · {data.tick_interval_s}s heartbeat
            </div>
            <div style={{ fontSize: 11, color: c.textSecondary, lineHeight: 1.55, marginBottom: 11 }}>
              {data.explainer}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {(data.feeds ?? []).map((f: any) => (
                <div key={f.feed} title={f.why} style={{
                  display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 8px',
                  borderRadius: 6, background: c.surfaceSubtle,
                }}>
                  <span style={{ fontSize: 11, color: c.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.label}
                  </span>
                  <span style={{ fontSize: 11, color: c.textMuted, whiteSpace: 'nowrap' }}>{f.source}</span>
                  <span style={{
                    fontSize: 11, fontWeight: 800, color: 'var(--clt-blue)',
                    fontVariantNumeric: 'tabular-nums', minWidth: 30, textAlign: 'right',
                  }}>
                    {f.interval_label}
                  </span>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${c.borderSubtle}` }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: c.textMuted, marginBottom: 6 }}>
                Held after an action ({holds})
              </div>
              {holds === 0 ? (
                <div style={{ fontSize: 11, color: c.textSecondary, lineHeight: 1.5 }}>
                  Nothing is pinned. Resolve an alert and the entity you touched is held here, so the
                  simulation cannot overwrite the effect before you have seen it.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(data.holds ?? []).slice(0, 8).map((h: any) => (
                    <div key={h.entity} style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                      <Lock size={10} color="#10B981" style={{ flexShrink: 0, marginTop: 2 }} />
                      <span style={{ flex: 1, minWidth: 0, color: c.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                        {h.entity}
                      </span>
                      <span style={{ color: c.textMuted, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                        {Math.ceil(h.expires_in_s / 60)}m left
                      </span>
                    </div>
                  ))}
                  {holds > 8 && (
                    <div style={{ fontSize: 11, color: c.textMuted }}>+ {holds - 8} more</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** Distinct, deliberately un-alarming state for a queue that is genuinely clear. */
export function AllClear({ title, body, tone = '#10B981' }: { title: string; body: string; tone?: string }) {
  const { c } = useTheme()
  return (
    <div style={{
      textAlign: 'center', padding: '26px 18px', borderRadius: 10,
      background: `${tone}0d`, border: `1px dashed ${tone}44`,
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: '50%', background: `${tone}1e`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 9px',
      }}>
        <Check size={17} color={tone} />
      </div>
      <div style={{ fontSize: 13, fontWeight: 800, color: c.textPrimary, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 11, color: c.textSecondary, lineHeight: 1.55, maxWidth: 280, margin: '0 auto' }}>
        {body}
      </div>
    </div>
  )
}

/**
 * "What has actually been done here today?" — for any section where ATLAS can
 * act on its own.
 *
 * This exists because live state cannot answer that question. An autonomous
 * action's whole purpose is to return the network to normal, so a section that
 * is quiet because ATLAS worked all morning looks identical to one that is quiet
 * because nothing happened. Nor can the entities themselves carry the evidence:
 * they go back to drifting on their own feed the moment the action lands.
 *
 * Only the audit trail knows the difference, so that is what this counts — and
 * clicking through opens the very entries behind the number, rather than a
 * separate view that might disagree with it.
 *
 * Pass `section` to count exactly the actions the Governance tab lists under
 * that section; omit it to count the whole module.
 */
export function ActionedToday({ module, section, label, emptyHint }: {
  module: string
  section?: string
  /** Noun for what gets actioned here, e.g. "round", "van alert". */
  label: string
  emptyHint?: string
}) {
  const { c } = useTheme()
  const openAiPanel = useStore(s => s.openAiPanel)
  const { data } = useQuery({
    queryKey: ['actions-today'],
    queryFn: fetchActionsToday,
    refetchInterval: 60_000,
  })

  const mod = data?.modules?.[module]
  const bucket = section ? mod?.sections?.[section] : mod
  const n = bucket?.actions ?? 0
  const plural = n === 1 ? '' : 's'

  if (!n) {
    return (
      <div style={{
        fontSize: 11, color: 'var(--clt-grey-500)', background: 'var(--clt-grey-50)',
        border: '1px solid var(--clt-grey-100)', borderRadius: 7,
        padding: '8px 11px', marginBottom: 9, lineHeight: 1.5,
      }}>
        {emptyHint ?? `No ${label} actioned yet today.`} Actions taken here — by you or by ATLAS —
        are recorded in the audit trail.
      </div>
    )
  }

  const detail = [
    bucket!.auto > 0 ? `${bucket!.auto} by ATLAS` : null,
    bucket!.approved > 0 ? `${bucket!.approved} approved` : null,
    bucket!.operator > 0 ? `${bucket!.operator} by an operator` : null,
  ].filter(Boolean).join(' · ')

  return (
    <button
      onClick={() => openAiPanel('audit')}
      title="Open the audit trail"
      style={{
        display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left',
        background: '#8B5CF610', border: '1px solid #8B5CF62e', borderRadius: 8,
        padding: '10px 12px', marginBottom: 9, cursor: 'pointer',
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 30, height: 30, borderRadius: 8, background: '#8B5CF61f', flexShrink: 0,
      }}><Sparkles size={15} color="#8B5CF6" /></span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: c.textPrimary, lineHeight: 1.3 }}>
          {n} {label}{plural} actioned today
        </div>
        {detail && (
          <div style={{ fontSize: 11, color: 'var(--clt-grey-500)', marginTop: 2 }}>{detail}</div>
        )}
      </div>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0,
        fontSize: 11, fontWeight: 700, color: '#8B5CF6',
      }}>
        Audit trail <ChevronRight size={13} />
      </span>
    </button>
  )
}
