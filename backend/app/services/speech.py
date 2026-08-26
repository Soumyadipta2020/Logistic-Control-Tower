"""
Turning an ATLAS answer into something worth listening to.

The answer on screen is a document: headings, bold figures, `SKU-BLR-002`, and a
five-column table. Read literally that becomes "hash hash where it hurts,
asterisk asterisk sixty four point eight percent asterisk asterisk, pipe pipe" —
which is not an accessibility feature, it is noise. And a table is the one shape
that genuinely does not survive being spoken: five columns by six rows is thirty
values with no structure to hold them in.

So this rewrites the answer for the ear rather than reading the page aloud:
markup is stripped, currency and codes are expanded into the words a person
would actually say, and a table is named and left on screen where it can be
read. The spoken version is deliberately allowed to differ from the written one —
what must not differ is the FACTS, so nothing is summarised or dropped except
markup and tabular detail that has a visible home.
"""

from __future__ import annotations

import re

# Long answers are capped: past roughly two minutes of speech an operator has
# stopped listening and is reading the screen anyway.
MAX_SPEECH_CHARS = 1400


def _expand_money(text: str) -> str:
    """£1,598,087 → "1.6 million pounds". Digit-by-digit currency is unlistenable,
    and the magnitude is the part that matters when it is spoken."""
    def repl(m: re.Match) -> str:
        n = float(m.group(1).replace(",", ""))
        if n >= 1_000_000:
            v = round(n / 1_000_000, 1)
            return f"{v:g} million pounds"
        if n >= 1_000:
            v = round(n / 1_000)
            return f"{v:,} thousand pounds"
        return f"{n:g} pounds"
    return re.sub(r"£\s?([\d,]+(?:\.\d+)?)", repl, text)


def _expand_codes(text: str) -> str:
    """SKU-BLR-002 → "S K U dash B L R dash 002". Reference codes are the thing an
    operator most needs to catch exactly, and run together they are unintelligible."""
    def repl(m: re.Match) -> str:
        code = m.group(0)
        out = []
        for part in code.split("-"):
            out.append(" ".join(part) if part.isalpha() and len(part) <= 4 else part)
        return " dash ".join(out)
    return re.sub(r"\b[A-Z]{2,4}-[A-Z0-9]{2,6}(?:-[A-Z0-9]{1,6})?\b", repl, text)


def to_speech(markdown: str) -> str:
    """An ATLAS answer, rewritten to be heard."""
    if not markdown:
        return ""
    lines = markdown.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    in_code = False
    table_rows = 0

    for raw in lines:
        line = raw.rstrip()

        if line.strip().startswith("```"):
            in_code = not in_code
            if not in_code:
                out.append("Code block shown on screen.")
            continue
        if in_code:
            continue

        # Tables: named once, then left to the screen.
        if re.match(r"^\s*\|.*\|\s*$", line):
            table_rows += 1
            continue
        if table_rows:
            body = max(0, table_rows - 2)   # header + divider are not data
            out.append(f"There is a table on screen with {body} row{'s' if body != 1 else ''}."
                       if body else "There is a table on screen.")
            table_rows = 0

        if not line.strip():
            continue
        if re.match(r"^\s*([-*_])\1{2,}\s*$", line):        # horizontal rule
            continue

        line = re.sub(r"^\s*#{1,6}\s*", "", line)            # headings read as sentences
        line = re.sub(r"^\s*>\s?", "", line)                 # blockquote marker
        line = re.sub(r"^\s*([-*•])\s+", "", line)           # bullet marker
        line = re.sub(r"^\s*(\d+)[.)]\s+", r"\1. ", line)    # keep ordinal numbering
        line = re.sub(r"\*\*(.+?)\*\*", r"\1", line)
        line = re.sub(r"__(.+?)__", r"\1", line)
        line = re.sub(r"(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)", r"\1", line)
        line = re.sub(r"`([^`]+)`", r"\1", line)
        line = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", line)  # link text only

        line = line.strip()
        if line:
            out.append(line if line[-1] in ".!?:" else line + ".")

    if table_rows:
        body = max(0, table_rows - 2)
        out.append(f"There is a table on screen with {body} row{'s' if body != 1 else ''}." if body
                   else "There is a table on screen.")

    text = " ".join(out)
    text = _expand_money(text)
    text = _expand_codes(text)
    text = re.sub(r"\s{2,}", " ", text).strip()

    if len(text) > MAX_SPEECH_CHARS:
        cut = text.rfind(". ", 0, MAX_SPEECH_CHARS)
        text = (text[:cut + 1] if cut > 400 else text[:MAX_SPEECH_CHARS]) + \
               " The rest of the answer is on screen."
    return text


def spoken_actions(executed: list[dict], proposals: list[dict]) -> str:
    """What the turn DID, said out loud.

    An operator listening rather than looking must not miss that something ran,
    or that something is waiting on them — those are the two facts in the whole
    exchange that carry consequence.
    """
    bits: list[str] = []
    if executed:
        bits.append(f"I have already carried out {len(executed)} action"
                    f"{'s' if len(executed) != 1 else ''}.")
    live = [p for p in proposals if not (p.get("governance") or {}).get("blocked")]
    blocked = len(proposals) - len(live)
    if live:
        bits.append(f"There {'is' if len(live) == 1 else 'are'} {len(live)} approval card"
                    f"{'s' if len(live) != 1 else ''} waiting for your decision below.")
    if blocked:
        bits.append(f"{blocked} prepared action{'s' if blocked != 1 else ''} "
                    "cannot be authorised with your permissions.")
    return " ".join(bits)
