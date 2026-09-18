// Feed streamed token fragments, get back complete sentences as they close.
// A sentence ends at . ! ? … (optionally followed by closing quotes/brackets) plus whitespace,
// or at a newline. The first chunk may be released early at a clause break once it has
// `firstMinWords` words, to shave time-to-first-audio. Run-on text is cut at `maxChars`.
// A full stop after a title or initial ("Dr. Smith", "J. K. Rowling", "e.g. this") is not an end.

const END = /([.!?…]+["')\]]*)(\s+|$)/g
const CLAUSE = /([,;:—–-])\s+/

const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'st', 'vs', 'inc', 'ltd', 'co', 'mt', 'ft', 'approx', 'dept', 'est'])

/** True when the terminator at `end` (exclusive index of the punctuation run) is not a sentence end. */
function isAbbreviation(buf: string, punctStart: number, punct: string): boolean {
  if (punct !== '.') return false
  const before = buf.slice(0, punctStart)
  const word = /([A-Za-z]+)$/.exec(before)?.[1]
  if (!word) return false
  if (word.length === 1 && /[A-Z]/.test(word)) return true // initial: "J. K. Rowling"
  if (ABBREVIATIONS.has(word.toLowerCase())) return true
  return /\b[a-z]\.[a-z]$/i.test(before) // "e.g", "i.e", "u.s"
}

function findEnd(buf: string): { start: number; end: number; terminal: boolean } | null {
  END.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = END.exec(buf))) {
    const punct = m[1]!
    const atEnd = (m[2] ?? '').length === 0
    if (isAbbreviation(buf, m.index, punct.replace(/["')\]]+$/, ''))) {
      if (atEnd) return null
      continue
    }
    return { start: m.index, end: m.index + m[0].length, terminal: atEnd }
  }
  return null
}

export class SentenceChunker {
  private buf = ''
  private emitted = 0

  constructor(
    private readonly maxChars = 220,
    private readonly firstMinWords = 6
  ) {}

  feed(piece: string): string[] {
    this.buf += piece
    const out: string[] = []
    for (;;) {
      const m = findEnd(this.buf)
      // a terminator at the very end of the buffer may still be followed by more of the same
      // sentence ("3." + "5"), so only release it when something follows or on flush
      if (m && !m.terminal) {
        out.push(this.buf.slice(0, m.end).trim())
        this.buf = this.buf.slice(m.end)
        continue
      }
      const nl = this.buf.indexOf('\n')
      if (nl >= 0) {
        const s = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (s) out.push(s)
        continue
      }
      if (this.emitted === 0 && out.length === 0 && this.firstMinWords > 0) {
        const cm = CLAUSE.exec(this.buf)
        if (cm && cm.index !== undefined && this.buf.slice(0, cm.index).split(/\s+/).filter(Boolean).length >= this.firstMinWords) {
          const end = cm.index + cm[0].length
          out.push(this.buf.slice(0, end).trim())
          this.buf = this.buf.slice(end)
          continue
        }
      }
      if (this.buf.length > this.maxChars) {
        let cut = Math.max(this.buf.lastIndexOf(', ', this.maxChars), this.buf.lastIndexOf(' ', this.maxChars))
        if (cut <= 0) cut = this.maxChars
        out.push(this.buf.slice(0, cut).trim())
        this.buf = this.buf.slice(cut).trimStart()
        continue
      }
      break
    }
    const kept = out.filter(Boolean)
    this.emitted += kept.length
    return kept
  }

  flush(): string[] {
    const s = this.buf.trim()
    this.buf = ''
    if (!s) return []
    this.emitted += 1
    return [s]
  }
}
