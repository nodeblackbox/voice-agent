// Decides whether a final transcript looks like an unfinished thought ("and then I'll.",
// "Yeah, so basically") so the agent can hold its reply loosely: if the user starts speaking again
// inside the continuation window, the fragment and the continuation become one turn.

export type UnfinishedReason = 'filler' | 'timeout-low-p' | 'short' | 'dangling'

export interface UnfinishedOptions {
  endReason?: 'done' | 'timeout'
  turnP?: number | null
  fillerWords: Set<string>
  minWords: number
  lowP: number
}

export function parseFillerWords(list: string): Set<string> {
  return new Set(
    list
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean)
  )
}

const WORDS = /[a-z0-9']+/gi

export function lastWord(text: string): string {
  const words = text.toLowerCase().match(/[a-z']+/g)
  return words?.at(-1) ?? ''
}

export function unfinishedReason(text: string, o: UnfinishedOptions): UnfinishedReason | null {
  const words = text.match(WORDS) ?? []
  if (words.length < o.minWords) return 'short'
  if (o.endReason === 'timeout' && (o.turnP === null || o.turnP === undefined || o.turnP < o.lowP)) return 'timeout-low-p'
  if (/[,;:\-–—…]\s*$/.test(text.trim())) return 'dangling'
  if (o.fillerWords.has(lastWord(text))) return 'filler'
  return null
}

/** Join a fragment with its continuation; ASR puts a full stop on fragments, drop it when the next piece continues lowercase. */
export function mergeTexts(prev: string, next: string): string {
  let a = prev.trim()
  const b = next.trim()
  if (!a) return b
  if (!b) return a
  if (/[.]$/.test(a) && /^[a-z]/.test(b)) a = a.slice(0, -1)
  return `${a} ${b}`
}
