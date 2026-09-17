// Feed streamed token fragments, get back complete sentences as they close.
// A sentence ends at . ! ? … (optionally followed by closing quotes/brackets) plus whitespace,
// or at a newline. The first chunk may be released early at a clause break once it has
// `firstMinWords` words, to shave time-to-first-audio. Run-on text is cut at `maxChars`.

const END = /([.!?…]+["')\]]*)(\s+|$)/
const CLAUSE = /([,;:—–-])\s+/

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
      const m = END.exec(this.buf)
      if (m && m.index !== undefined && (m.index + m[0].length < this.buf.length || (m[2] ?? '').length > 0)) {
        const end = m.index + m[0].length
        out.push(this.buf.slice(0, end).trim())
        this.buf = this.buf.slice(end)
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
