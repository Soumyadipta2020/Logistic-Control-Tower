// Decorative line-art illustrations for the login carousel. Self-contained SVG —
// no external image requests — so the login screen never shows a broken graphic.
// Each is a loose visual metaphor for its capability, not a literal screenshot.

const orange = 'var(--exl-orange)'
const line = 'rgba(240, 244, 255, 0.28)'
const dim = 'rgba(240, 244, 255, 0.5)'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 200 112" width="100%" height="100%" fill="none" role="presentation">
      {children}
    </svg>
  )
}

export function MapGraphic() {
  return (
    <Frame>
      <path d="M0 90 H200" stroke={line} strokeWidth="1" strokeDasharray="1 7" />
      <path d="M0 60 H200 M0 30 H200" stroke={line} strokeWidth="1" strokeDasharray="1 9" opacity="0.5" />
      <path d="M28 82 C 55 40, 90 78, 118 46 S 168 24, 182 30" stroke={orange} strokeWidth="2" strokeDasharray="5 5" strokeLinecap="round" opacity="0.85" />
      <circle cx="28" cy="82" r="4" fill="rgba(240,244,255,0.6)" />
      <circle cx="118" cy="46" r="4" fill="rgba(240,244,255,0.6)" />
      <g>
        <circle cx="182" cy="30" r="4" fill={orange} />
        <circle cx="182" cy="30" r="9" stroke={orange} strokeWidth="1.5" opacity="0.55">
          <animate attributeName="r" values="6;15;6" dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.6;0;0.6" dur="2.4s" repeatCount="indefinite" />
        </circle>
      </g>
    </Frame>
  )
}

export function TruckGraphic() {
  return (
    <Frame>
      <path d="M0 92 H200" stroke={line} strokeWidth="1.5" />
      <path d="M10 92 L26 92 M42 92 L58 92 M74 92 L90 92" stroke={line} strokeWidth="1.5" strokeDasharray="2 6" opacity="0.7">
        <animate attributeName="d" values="M10 92 L26 92 M42 92 L58 92 M74 92 L90 92;M22 92 L38 92 M54 92 L70 92 M86 92 L102 92;M10 92 L26 92 M42 92 L58 92 M74 92 L90 92" dur="1.8s" repeatCount="indefinite" />
      </path>
      <g transform="translate(78,52)">
        <rect x="0" y="8" width="46" height="24" rx="3" fill="rgba(240,244,255,0.08)" stroke={dim} strokeWidth="1.4" />
        <path d="M46 16 H62 L72 26 V32 H46 Z" fill="rgba(251,78,11,0.14)" stroke={orange} strokeWidth="1.4" />
        <circle cx="14" cy="34" r="6" fill="#0F1629" stroke={dim} strokeWidth="1.6" />
        <circle cx="60" cy="34" r="6" fill="#0F1629" stroke={dim} strokeWidth="1.6" />
      </g>
    </Frame>
  )
}

export function InventoryGraphic() {
  const bars = [22, 40, 30, 52, 18]
  return (
    <Frame>
      <path d="M0 96 H200" stroke={line} strokeWidth="1" />
      {bars.map((h, i) => (
        <rect
          key={i}
          x={30 + i * 32}
          y={92 - h}
          width="18"
          height={h}
          rx="3"
          fill={i === 3 ? 'rgba(251,78,11,0.22)' : 'rgba(240,244,255,0.1)'}
          stroke={i === 3 ? orange : dim}
          strokeWidth="1.3"
        />
      ))}
      <path d="M28 60 L60 44 L92 52 L124 30 L156 38" stroke={orange} strokeWidth="1.6" strokeLinecap="round" opacity="0.7" />
    </Frame>
  )
}

export function IotGraphic() {
  return (
    <Frame>
      <g transform="translate(78,32)">
        <rect x="0" y="0" width="44" height="44" rx="6" fill="rgba(251,78,11,0.12)" stroke={orange} strokeWidth="1.5" />
        <circle cx="22" cy="22" r="6" fill="none" stroke={orange} strokeWidth="1.5" />
        {[10, 34].map((x) => (
          <g key={x}>
            <path d={`M${x} 0 V-8`} stroke={dim} strokeWidth="1.4" />
            <path d={`M${x} 44 V52`} stroke={dim} strokeWidth="1.4" />
          </g>
        ))}
        <path d="M0 14 H-8 M0 30 H-8 M44 14 H52 M44 30 H52" stroke={dim} strokeWidth="1.4" />
      </g>
      {[16, 24, 32].map((r, i) => (
        <circle key={r} cx="100" cy="54" r={r} stroke={orange} strokeWidth="1" fill="none" opacity={0.35 - i * 0.09}>
          <animate attributeName="opacity" values={`${0.4 - i * 0.1};0;${0.4 - i * 0.1}`} dur="2.6s" begin={`${i * 0.3}s`} repeatCount="indefinite" />
        </circle>
      ))}
    </Frame>
  )
}

export function SustainabilityGraphic() {
  return (
    <Frame>
      <path d="M0 96 H200" stroke={line} strokeWidth="1" />
      <path
        d="M100 90 C 100 60, 74 52, 74 30 C 74 52, 100 56, 100 90 Z"
        fill="rgba(52,211,153,0.14)"
        stroke="#34D399"
        strokeWidth="1.6"
      />
      <path d="M100 90 C 100 70, 108 62, 118 54" stroke="#34D399" strokeWidth="1.3" opacity="0.7" />
      <path d="M20 76 L48 60 L70 68 L96 44 L128 50 L156 30 L182 36" stroke={orange} strokeWidth="1.6" strokeLinecap="round" opacity="0.8" />
      <circle cx="182" cy="36" r="3.5" fill={orange} />
    </Frame>
  )
}

export function RiskGraphic() {
  return (
    <Frame>
      <g transform="translate(78,20)">
        <path d="M22 0 L44 8 V26 C44 42, 32 52, 22 56 C12 52, 0 42, 0 26 V8 Z" fill="rgba(251,78,11,0.12)" stroke={orange} strokeWidth="1.6" />
        <path d="M11 27 L18 34 L33 18" stroke={orange} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </g>
      {[[24, 30], [176, 26], [30, 86], [170, 82]].map(([x, y], i) => (
        <g key={i}>
          <path d={`M${x} ${y} L100 48`} stroke={line} strokeWidth="1" strokeDasharray="2 4" />
          <circle cx={x} cy={y} r="4" fill="rgba(240,244,255,0.5)" />
        </g>
      ))}
    </Frame>
  )
}
