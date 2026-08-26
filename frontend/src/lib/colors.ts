/* ═══════════════════════════════════════════════════════════════════════════════
   COLOUR — the JavaScript mirror of styles/tokens.css

   Most of this product styles through inline `style={{}}` objects, which cannot
   read CSS custom properties. That makes this file the effective palette for the
   majority of the UI: `c.textMuted` alone resolves into 161 rendered elements,
   `c.textSecondary` into 150. A wrong value here is a defect repeated hundreds
   of times — which is exactly what it was.

   ── WHAT CHANGED AND WHY ──────────────────────────────────────────────────────
   Every value below is verified against every surface it is permitted to sit on,
   in both themes. Three tokens were failing WCAG 2.2 SC 1.4.3 before:

     textMuted   light  #94A3B8 → #5F6D82    2.35:1 → 4.80:1   (161 call sites)
     textMuted   dark   #5E7491 → #8496AF    3.37:1 → 5.35:1
     chipText    light  #6B7280 → #4E5A6B    4.35:1 → 6.39:1

   and `border` was doing double duty as both decorative separation and control
   boundary, so `borderStrong` was added at ≥3:1 for the latter (SC 1.4.11).

   ── INVARIANT ─────────────────────────────────────────────────────────────────
   These values MUST stay in step with the semantic tokens in styles/tokens.css.
   Same names, same meanings, same measured ratios. When one moves, move both.
═══════════════════════════════════════════════════════════════════════════════ */

/** A background/border/foreground triple for a tinted status container. */
export interface StatusTone {
  /** Container fill. */
  bg: string
  /** Container boundary. */
  border: string
  /** Foreground for text inside the container — always ≥4.5:1 against `bg`. */
  text: string
  /** Saturated fill for dots, bars and chart marks. Non-text use only. */
  solid: string
  /** Foreground for text placed on `solid`. */
  onSolid: string
}

export interface AppColors {
  // ── Surfaces, ascending elevation ──
  surface: string
  surfaceSubtle: string
  surfaceMuted: string
  /** Recessed wells, code blocks, empty states. */
  surfaceInset: string

  // ── Borders ──
  /** Decorative separation between regions. Not a control boundary. */
  border: string
  borderSubtle: string
  /**
   * ≥3:1 boundary. Required whenever the border is the only thing identifying
   * an interactive control — inputs, selects, unfilled buttons (SC 1.4.11).
   */
  borderStrong: string

  // ── Text, descending emphasis. All ≥4.5:1 on every listed surface. ──
  textPrimary: string
  textSecondary: string
  /** De-emphasised, still readable. Never for anything load-bearing. */
  textMuted: string
  /** For text placed on a saturated/brand fill. */
  textInverse: string

  // ── Brand ──
  /** True EXL orange. Fills, rules, icons, large display type. */
  accent: string
  /** The ramp step that clears 4.5:1 for accent-coloured body text. */
  accentText: string
  /** The ramp step that clears 4.5:1 *under* white/inverse labels. */
  accentSolid: string
  accentSubtle: string

  // ── RAG. The product's core status vocabulary; meaning is fixed app-wide. ──
  ragBg: Record<'G' | 'A' | 'R', string>
  ragBorder: Record<'G' | 'A' | 'R', string>
  ragText: Record<'G' | 'A' | 'R', string>
  /** Saturated RAG for dots and bars. Non-text use only. */
  ragSolid: Record<'G' | 'A' | 'R', string>

  // ── Semantic tones ──
  info: StatusTone
  success: StatusTone
  warning: StatusTone
  danger: StatusTone
  /** Agentic/AI surfaces. Violet is reserved for machine-originated content. */
  ai: StatusTone
  neutral: StatusTone

  // ── Chips ──
  chipBg: string
  chipBorder: string
  chipText: string

  // ── Elevation, matched to --elevation-* ──
  elevation1: string
  elevation2: string
  elevation3: string
  elevation4: string

  // ── Focus ──
  focusRing: string
  focusHalo: string

  // ── Charts ──
  /**
   * Ordered categorical sequence, hue-separated so adjacent series stay
   * distinguishable under deuteranopia and protanopia. Status colours are
   * deliberately excluded: red/amber/green mean breach/at-risk/healthy
   * everywhere here, and a chart must not spend them on "Region 3".
   *
   * Colour is never the sole encoding — pair with a label, shape or annotation.
   */
  chart: string[]
  chartGrid: string
  chartAxis: string
  scrim: string
}

/* ═══════════════════════════════════════════════════════════════════════════════
   LIGHT
   Verified against surfaces #FFFFFF · #F4F5F7 · #F8FAFC · #F1F5F9.
   Ratios quoted are the WORST case across that set.
═══════════════════════════════════════════════════════════════════════════════ */
export const LIGHT: AppColors = {
  surface: '#FFFFFF',
  surfaceSubtle: '#F8FAFC',
  surfaceMuted: '#F1F5F9',
  surfaceInset: '#F1F5F9',

  border: '#E2E8F0',
  borderSubtle: '#F1F5F9',
  borderStrong: '#7E8CA3', // 3.12:1 on white — control boundary

  textPrimary: '#0F172A', // 16.1:1 AAA
  textSecondary: '#4E5A6B', //  6.39:1 AA
  textMuted: '#5F6D82', //  4.80:1 AA  (was #94A3B8 → 2.35:1 FAIL)
  textInverse: '#FFFFFF',

  accent: '#FB4E0B', // the brand, unaltered
  accentText: '#C43C05', //  5.26:1 AA on white
  accentSolid: '#D93D00', // white on it = 4.55:1 AA
  accentSubtle: 'rgba(251, 78, 11, 0.08)',

  ragBg: { G: '#F0FDF4', A: '#FFFBEB', R: '#FEF2F2' },
  ragBorder: { G: '#BBF7D0', A: '#FDE68A', R: '#FECACA' },
  ragText: { G: '#166534', A: '#92400E', R: '#991B1B' }, // 7.0 / 6.4 / 7.6 on own bg
  ragSolid: { G: '#10B981', A: '#F59E0B', R: '#EF4444' },

  info: {
    bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8', // 7.0:1 on bg
    solid: '#2563EB', onSolid: '#FFFFFF', //             5.2:1
  },
  success: {
    bg: '#F0FDF4', border: '#BBF7D0', text: '#166534', // 7.0:1
    solid: '#047857', onSolid: '#FFFFFF', //             5.5:1
  },
  warning: {
    bg: '#FFFBEB', border: '#FDE68A', text: '#92400E', // 6.4:1
    solid: '#B45309', onSolid: '#FFFFFF', //             5.0:1
  },
  danger: {
    bg: '#FEF2F2', border: '#FECACA', text: '#B91C1C', // 6.2:1
    solid: '#DC2626', onSolid: '#FFFFFF', //             4.8:1
  },
  ai: {
    bg: '#F5F3FF', border: '#DDD6FE', text: '#6D28D9', // 6.9:1
    solid: '#7C3AED', onSolid: '#FFFFFF', //             5.7:1
  },
  neutral: {
    bg: '#F1F5F9', border: '#CBD5E1', text: '#4E5A6B', // 6.4:1
    solid: '#334155', onSolid: '#FFFFFF', //            10.4:1
  },

  chipBg: '#F1F5F9',
  chipBorder: '#CBD5E1',
  chipText: '#4E5A6B', // 6.39:1  (was #6B7280 → 4.35:1)

  elevation1: '0 1px 2px -1px rgb(15 23 42 / 0.10), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
  elevation2: '0 2px 4px -2px rgb(15 23 42 / 0.10), 0 4px 8px -2px rgb(15 23 42 / 0.08)',
  elevation3: '0 4px 8px -4px rgb(15 23 42 / 0.12), 0 10px 20px -6px rgb(15 23 42 / 0.10)',
  elevation4: '0 8px 16px -8px rgb(15 23 42 / 0.16), 0 20px 40px -12px rgb(15 23 42 / 0.14)',

  focusRing: '#FB4E0B', // 3.11:1 vs light surfaces
  focusHalo: '#FFFFFF',

  chart: ['#2563EB', '#FB4E0B', '#0F766E', '#7C3AED', '#B45309', '#0891B2', '#BE185D', '#4E5A6B'],
  chartGrid: '#E2E8F0',
  chartAxis: '#5F6D82',
  scrim: 'rgb(15 23 42 / 0.42)',
}

/* ═══════════════════════════════════════════════════════════════════════════════
   DARK
   Verified against surfaces #111827 · #05070F · #1A2035 · #151E2E.

   Not an inversion of LIGHT. Surfaces climb toward the light as they rise, and
   status foregrounds move to the pale end of each ramp — the saturated mid-tones
   that read well on white turn muddy on near-black.
═══════════════════════════════════════════════════════════════════════════════ */
export const DARK: AppColors = {
  surface: '#111827',
  surfaceSubtle: '#1A2035',
  surfaceMuted: '#1E2739',
  surfaceInset: '#0B1020',

  border: '#273347',
  borderSubtle: '#1E2A3D',
  borderStrong: '#5D7091', // 3.22:1 on card

  textPrimary: '#F0F4FF', // 17.4:1 AAA
  textSecondary: '#A8B8D0', //  8.01:1 AAA
  textMuted: '#8496AF', //  5.35:1 AA  (was #5E7491 → 3.37:1 FAIL)
  textInverse: '#0F172A',

  accent: '#FF6D35',
  accentText: '#FF8A5C', // 6.94:1
  accentSolid: '#FB4E0B',
  accentSubtle: 'rgba(255, 109, 53, 0.14)',

  ragBg: { G: 'rgba(16,185,129,0.14)', A: 'rgba(245,158,11,0.14)', R: 'rgba(239,68,68,0.14)' },
  ragBorder: { G: 'rgba(16,185,129,0.34)', A: 'rgba(245,158,11,0.34)', R: 'rgba(239,68,68,0.34)' },
  ragText: { G: '#6EE7B7', A: '#FDE68A', R: '#FCA5A5' }, // 11.6 / 14.2 / 9.4
  ragSolid: { G: '#10B981', A: '#F59E0B', R: '#EF4444' },

  info: {
    bg: 'rgba(59,130,246,0.14)', border: 'rgba(59,130,246,0.34)', text: '#93C5FD', // 9.8:1
    solid: '#2563EB', onSolid: '#FFFFFF',
  },
  success: {
    bg: 'rgba(16,185,129,0.14)', border: 'rgba(16,185,129,0.34)', text: '#6EE7B7', // 11.6:1
    solid: '#10B981', onSolid: '#0F172A',
  },
  warning: {
    bg: 'rgba(245,158,11,0.14)', border: 'rgba(245,158,11,0.34)', text: '#FDE68A', // 14.2:1
    solid: '#F59E0B', onSolid: '#0F172A',
  },
  danger: {
    bg: 'rgba(239,68,68,0.14)', border: 'rgba(239,68,68,0.34)', text: '#FCA5A5', // 9.4:1
    solid: '#DC2626', onSolid: '#FFFFFF',
  },
  ai: {
    bg: 'rgba(139,92,246,0.14)', border: 'rgba(139,92,246,0.34)', text: '#C4B5FD', // 9.6:1
    solid: '#7C3AED', onSolid: '#FFFFFF',
  },
  neutral: {
    bg: '#1A2035', border: '#273347', text: '#A8B8D0', // 8.0:1
    solid: '#5F6D82', onSolid: '#FFFFFF',
  },

  chipBg: '#1A2035',
  chipBorder: '#273347',
  chipText: '#A8B8D0',

  elevation1: '0 1px 2px -1px rgb(0 0 0 / 0.60), inset 0 1px 0 0 rgb(255 255 255 / 0.03)',
  elevation2: '0 2px 6px -2px rgb(0 0 0 / 0.70), inset 0 1px 0 0 rgb(255 255 255 / 0.04)',
  elevation3: '0 8px 20px -6px rgb(0 0 0 / 0.78), inset 0 1px 0 0 rgb(255 255 255 / 0.05)',
  elevation4: '0 16px 40px -12px rgb(0 0 0 / 0.85), inset 0 1px 0 0 rgb(255 255 255 / 0.07)',

  focusRing: '#FF7A45', // 6.86:1
  focusHalo: '#05070F',

  chart: ['#60A5FA', '#FF8A5C', '#5EEAD4', '#C4B5FD', '#FBBF24', '#67E8F9', '#F9A8D4', '#A8B8D0'],
  chartGrid: '#273347',
  chartAxis: '#8496AF',
  scrim: 'rgb(2 4 10 / 0.68)',
}

/* ═══════════════════════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════════════════════ */

/** Map a RAG letter onto its full tone. Keeps status styling to one decision. */
export function ragTone(c: AppColors, rag: 'G' | 'A' | 'R'): StatusTone {
  const map = { G: c.success, A: c.warning, R: c.danger } as const
  return map[rag]
}

/**
 * Series colour by index, wrapping the categorical sequence.
 * Pass the same index for the same series across every chart on a page so a
 * series keeps one identity — that is the whole point of an ordered sequence.
 */
export function seriesColor(c: AppColors, index: number): string {
  return c.chart[index % c.chart.length]
}
