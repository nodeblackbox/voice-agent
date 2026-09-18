// What did the user actually hear before an interruption? Sentences the renderer finished count in
// full, the sentence that was playing when the cut landed counts proportionally to how far it got,
// fillers never count, and everything after that is the unspoken remainder the model must not repeat.

export interface SpokenChunk {
  seq: number
  text: string
  kind: 'speech' | 'filler'
}

export interface CutPoint {
  seq: number
  offsetS: number
  durationS: number
}

export interface SpokenSplit {
  spoken: string
  unspoken: string
  /** Sequence numbers counted as heard (fully or partially). */
  heardSeqs: number[]
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * `finished` = seqs whose playback ended; `started` = seqs whose playback began. When the renderer
 * reported where the cut landed (`cut`), that sentence is word-sliced; otherwise a started sentence
 * is counted in full (provisional, refined when the report arrives).
 */
export function splitSpoken(fullText: string, chunks: SpokenChunk[], finished: Set<number>, started: Set<number>, cut: CutPoint | null): SpokenSplit {
  const parts: string[] = []
  const heard: number[] = []
  for (const c of [...chunks].sort((a, b) => a.seq - b.seq)) {
    if (c.kind !== 'speech' || !c.text) continue
    if (finished.has(c.seq)) {
      parts.push(c.text)
      heard.push(c.seq)
    } else if (cut && cut.seq === c.seq) {
      const words = c.text.split(/\s+/).filter(Boolean)
      const fraction = cut.durationS > 0 ? Math.min(1, Math.max(0, cut.offsetS / cut.durationS)) : 0
      const k = Math.min(words.length, Math.max(1, Math.round(words.length * fraction)))
      parts.push(words.slice(0, k).join(' '))
      heard.push(c.seq)
    } else if (!cut && started.has(c.seq)) {
      parts.push(c.text)
      heard.push(c.seq)
    }
  }
  const spoken = norm(parts.join(' '))
  return { spoken, unspoken: remainder(fullText, spoken), heardSeqs: heard }
}

/** The part of `full` after `spoken`, tolerant of whitespace and of voice-side filtering. */
export function remainder(full: string, spoken: string): string {
  const f = norm(full)
  if (!spoken) return f
  const s = norm(spoken)
  if (f.startsWith(s)) return f.slice(s.length).trim()
  const idx = f.indexOf(s)
  if (idx >= 0) return f.slice(idx + s.length).trim()
  // the voice said a filtered version of the text (markdown stripped, code narrated): anchor on
  // the last few spoken words instead
  const spokenWords = s.split(' ')
  for (let k = Math.min(6, spokenWords.length); k >= 2; k--) {
    const tail = spokenWords.slice(-k).join(' ')
    const at = f.lastIndexOf(tail)
    if (at >= 0) return f.slice(at + tail.length).trim()
  }
  return f.split(' ').slice(spokenWords.length).join(' ').trim()
}

/** The note appended to an interrupted assistant message in the model's history. */
export function interruptionNote(unspoken: string, maxChars = 300): string {
  if (!unspoken.trim()) return '[interrupted by the user here]'
  const rest = unspoken.length > maxChars ? `${unspoken.slice(0, maxChars - 1).trimEnd()}…` : unspoken
  return `[interrupted by the user here; the rest was never spoken: "${rest}"]`
}
