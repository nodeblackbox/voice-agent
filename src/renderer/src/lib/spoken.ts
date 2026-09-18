// Splits an assistant reply into what has been spoken, what is being spoken right now and what is
// still to come, by locating the TTS sentence chunks inside the full text.

export type SpanState = 'spoken' | 'current' | 'upcoming' | 'plain'

export interface Span {
  text: string
  state: SpanState
}

export interface ChunkText {
  seq: number
  text: string
  kind: 'speech' | 'filler'
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * `chunks` in seq order (fillers ignored); `currentSeq` is the chunk playing now. Text that cannot be
 * located (markdown was filtered before the voice saw it) falls back to a single plain span.
 */
export function splitBySentences(text: string, chunks: ChunkText[], currentSeq: number | null): Span[] {
  const speech = chunks.filter((c) => c.kind === 'speech' && c.text).sort((a, b) => a.seq - b.seq)
  if (!text || !speech.length || currentSeq === null) return [{ text, state: 'plain' }]
  const spans: Span[] = []
  let cursor = 0
  let located = 0
  for (const c of speech) {
    const idx = findChunk(text, c.text, cursor)
    if (idx < 0) break
    const end = idx + c.text.length
    const state: SpanState = c.seq < currentSeq ? 'spoken' : c.seq === currentSeq ? 'current' : 'upcoming'
    if (idx > cursor) spans.push({ text: text.slice(cursor, idx), state: state === 'spoken' ? 'spoken' : state === 'current' ? 'spoken' : 'upcoming' })
    spans.push({ text: text.slice(idx, end), state })
    cursor = end
    located++
  }
  if (!located) return [{ text, state: 'plain' }]
  if (cursor < text.length) spans.push({ text: text.slice(cursor), state: 'upcoming' })
  return mergeAdjacent(spans)
}

/** Exact match first, then whitespace-insensitive. */
function findChunk(text: string, chunk: string, from: number): number {
  const direct = text.indexOf(chunk, from)
  if (direct >= 0) return direct
  const target = norm(chunk)
  if (!target) return -1
  // walk candidate starts at word boundaries and compare normalised windows
  const re = /\S/g
  re.lastIndex = from
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const window = text.slice(m.index, m.index + chunk.length + 40)
    if (norm(window).startsWith(target)) {
      // find the exact end by growing until the normalised prefix matches the whole chunk
      let end = m.index
      while (end <= text.length && norm(text.slice(m.index, end)) !== target) end++
      return end > text.length ? -1 : m.index
    }
    re.lastIndex = m.index + 1
  }
  return -1
}

function mergeAdjacent(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const s of spans) {
    const last = out.at(-1)
    if (last && last.state === s.state) last.text += s.text
    else out.push({ ...s })
  }
  return out
}

/** After an interruption: the heard prefix and the never-played remainder. */
export function splitInterrupted(text: string, spokenText: string | undefined, unspokenText: string | undefined): { heard: string; rest: string } | null {
  if (!text) return null
  const rest = unspokenText ?? ''
  if (!rest.trim()) return spokenText !== undefined && !spokenText.trim() ? { heard: '', rest: text } : null
  if (text.endsWith(rest)) return { heard: text.slice(0, text.length - rest.length), rest }
  const idx = text.lastIndexOf(rest)
  if (idx >= 0) return { heard: text.slice(0, idx), rest: text.slice(idx) }
  const n = norm(text)
  const i = n.lastIndexOf(norm(rest))
  if (i >= 0) return { heard: n.slice(0, i), rest: n.slice(i) }
  return null
}
