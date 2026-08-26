// A small, dependency-free GitHub-flavoured-markdown renderer.
//
// ATLAS answers in markdown because that is how the answers actually come out:
// a headline sentence, then bullets, then a table when three carriers are being
// compared on the same three fields. Rendering it as plain text throws that
// structure away and leaves the operator reading asterisks; pulling in a full
// markdown library for one chat surface is more dependency than the job needs.
//
// So this handles exactly the subset the model is instructed to produce —
// headings, bullets, ordered lists, tables, code, blockquotes, rules, links —
// and treats anything it does not recognise as a paragraph, which is the safe
// failure: the text still reads, it just isn't decorated.

import { Fragment, type ReactNode } from 'react'

// ── inline: `code`, **bold**, *italic*, [text](url) ──────────────────────────
const INLINE = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(__[^_]+?__)|(\*[^*\n]+?\*)|(\[[^\]]+\]\([^)\s]+\))/g

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const k = `${keyBase}-${m.index}`
    if (tok.startsWith('`')) {
      out.push(<code key={k} className="md-code">{tok.slice(1, -1)}</code>)
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(<strong key={k}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('[')) {
      const cut = tok.indexOf('](')
      out.push(
        <a key={k} href={tok.slice(cut + 2, -1)} target="_blank" rel="noreferrer noopener" className="md-link">
          {tok.slice(1, cut)}
        </a>
      )
    } else {
      out.push(<em key={k}>{tok.slice(1, -1)}</em>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)
const isDivider = (l: string) => /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(l) && l.includes('-')
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

export function Markdown({ text }: { text: string }) {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // fenced code
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++
      out.push(
        <pre key={`c${i}`} className="md-pre" data-lang={lang || undefined}>
          <code>{body.join('\n')}</code>
        </pre>
      )
      continue
    }

    if (!line.trim()) { i++; continue }

    // horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push(<hr key={`h${i}`} className="md-hr" />); i++; continue }

    // heading
    const head = /^(#{1,4})\s+(.*)$/.exec(line)
    if (head) {
      const level = head[1].length
      out.push(
        <div key={`t${i}`} className={`md-h md-h${level}`}>{inline(head[2], `t${i}`)}</div>
      )
      i++
      continue
    }

    // table — a header row followed by a |---|---| divider
    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const header = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]))
      out.push(
        <div key={`tb${i}`} className="md-table-wrap">
          <table className="md-table">
            <thead><tr>{header.map((h, j) => <th key={j}>{inline(h, `th${j}`)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{header.map((_, ci) => <td key={ci}>{inline(r[ci] ?? '', `td${ri}-${ci}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(<blockquote key={`q${i}`} className="md-quote">{inline(body.join(' '), `q${i}`)}</blockquote>)
      continue
    }

    // lists — bullets and numbers, nesting by leading indent
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: { depth: number; text: string }[] = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        const raw = lines[i]
        const depth = Math.min(2, Math.floor((raw.length - raw.trimStart().length) / 2))
        items.push({ depth, text: raw.trim().replace(/^([-*•]|\d+[.)])\s+/, '') })
        i++
        // a wrapped continuation line belongs to the item above it
        while (i < lines.length && lines[i].trim() && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])
               && !/^\s*[#>|]/.test(lines[i]) && /^\s{2,}/.test(lines[i])) {
          items[items.length - 1].text += ' ' + lines[i++].trim()
        }
      }
      const List = ordered ? 'ol' : 'ul'
      out.push(
        <List key={`l${i}`} className={ordered ? 'md-ol' : 'md-ul'}>
          {items.map((it, j) => (
            <li key={j} style={it.depth ? { marginLeft: it.depth * 14 } : undefined}>
              {inline(it.text, `li${j}`)}
            </li>
          ))}
        </List>
      )
      continue
    }

    // paragraph — everything up to the next blank line or block starter
    const para: string[] = []
    while (i < lines.length && lines[i].trim()
           && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])
           && !/^\s*[#>]/.test(lines[i]) && !/^\s*```/.test(lines[i])
           && !isTableRow(lines[i])) {
      para.push(lines[i++].trim())
    }
    if (para.length) out.push(<p key={`p${i}`} className="md-p">{inline(para.join(' '), `p${i}`)}</p>)
  }

  return <div className="md">{out.map((node, k) => <Fragment key={k}>{node}</Fragment>)}</div>
}
