// The face ATLAS wears everywhere it speaks.
//
// It used to borrow two different stock glyphs — a Sparkles in the chat thread and
// a Bot on the launcher — so the agent that answers you and the agent you click to
// open were not visibly the same thing. This is one mark instead, and it is drawn
// as the thing the product is: a hub-and-spoke network, one hub holding three
// outer nodes on its routes. That is the shape of a control tower, not a chat toy.
//
// The hub is drawn as the droid itself — a head with two eyes — so the mark reads
// as an agent sitting at the centre of the network rather than an abstract diagram.
// The north spoke doubles as its antenna and the north node as the antenna's
// beacon: one shape doing two jobs, which is what keeps this legible small.
//
// Built on a 24px grid, with the routes stroked thinner than the head so the eyes
// stay the highest-contrast thing at the 13px the message avatar uses. Everything
// is currentColor, so the orb's gradient keeps doing the colour work.

// The two ground routes, at 30° and 150°. Each runs between radius 5.3 and 7.2 —
// starting outside the head's corner, stopping short of the node — with the node
// centre at 8.7 on the same bearing.
const ROUTES = [
  { x: 19.53, y: 16.35, x1: 16.59, y1: 14.65, x2: 18.23, y2: 15.60 }, // south-east
  { x: 4.47, y: 16.35, x1: 7.41, y1: 14.65, x2: 5.77, y2: 15.60 },   // south-west
]

export function AtlasGlyph({ size = 14, strokeWidth = 2 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      {/* Routes out to the network, held short of both ends so the head and the
          nodes stay separate points instead of fusing into an asterisk */}
      {ROUTES.map((r) => (
        <path key={`r${r.x}`} d={`M${r.x1} ${r.y1} ${r.x2} ${r.y2}`}
          strokeWidth={Math.max(1.1, strokeWidth - 0.6)} />
      ))}
      {ROUTES.map((r) => (
        <circle key={`n${r.x}`} cx={r.x} cy={r.y} r="1.75" fill="currentColor" stroke="none" />
      ))}

      {/* Antenna — the north spoke — and its beacon, the third node in the network */}
      <path d="M12 8.7 12 6.6" strokeWidth={Math.max(1.1, strokeWidth - 0.6)} />
      <circle cx="12" cy="4.4" r="1.75" fill="currentColor" stroke="none" />

      {/* The droid's head. Left as an outline so the eyes read as eyes; a filled
          head would collapse to a plain dot at small sizes. */}
      <rect x="8.2" y="8.7" width="7.6" height="6.6" rx="2.2" />
      <circle cx="10.3" cy="12.1" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="13.7" cy="12.1" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  )
}

// The full avatar: orb, orbiting ring, glyph. `className` carries the size — the
// existing .atlas-head-orb / .atlas-msg-orb / .atlas-welcome-orb rules set the box,
// and `glyph` is the inner icon size that suits it.
export function AtlasMark({ className = '', glyph = 13, strokeWidth = 2 }:
  { className?: string; glyph?: number; strokeWidth?: number }) {
  return (
    <span className={`ai-orb-mark ${className}`.trim()}>
      <span className="ai-orb-ring" />
      <AtlasGlyph size={glyph} strokeWidth={strokeWidth} />
    </span>
  )
}
