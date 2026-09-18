// After the user cuts the agent off, what they said decides what happens next. "Go on" or a bare
// backchannel ("mhm", "yeah") means "keep talking": the app replays the reply from the start of the
// sentence that was cut, with no model call. Anything else is a new turn and the model gets the
// interruption note as before.

export type AfterCut = 'resume' | 'backchannel' | 'new'

export interface AfterCutOptions {
  /** Comma-separated phrases that ask for the rest ("continue, go on, keep going…"). */
  resumePhrases: string
  /** Comma-separated words that only acknowledge ("yeah, ok, mhm…"). */
  backchannelWords: string
}

export { DEFAULT_BACKCHANNEL_WORDS, DEFAULT_RESUME_PHRASES } from '@shared/tuning'

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export function parseList(text: string): string[] {
  return [...new Set(text.split(',').map((p) => norm(p)).filter(Boolean))].sort((a, b) => b.length - a.length)
}

/** Remove every occurrence of the listed phrases (longest first) from a normalised word list. */
function stripPhrases(words: string[], phrases: string[]): string[] {
  let out = words
  for (const p of phrases) {
    const pw = p.split(' ')
    const next: string[] = []
    for (let i = 0; i < out.length; ) {
      if (pw.every((w, k) => out[i + k] === w)) i += pw.length
      else next.push(out[i++]!)
    }
    out = next
  }
  return out
}

/**
 * `text` is the user's whole utterance after the cut. A question is always new. A short utterance
 * that is nothing but backchannel words is a backchannel. A short utterance whose only non-backchannel
 * content is a resume phrase asks for the rest.
 */
export function classifyAfterCut(text: string, opts: AfterCutOptions): AfterCut {
  if (/\?/.test(text)) return 'new'
  const words = norm(text).split(' ').filter(Boolean)
  if (!words.length) return 'new'
  const backchannel = parseList(opts.backchannelWords)
  const phrases = parseList(opts.resumePhrases)
  if (words.length <= 3 && stripPhrases(words, backchannel).length === 0) return 'backchannel'
  if (words.length <= 6) {
    const rest = stripPhrases(words, phrases)
    const hadPhrase = rest.length < words.length
    if (hadPhrase && stripPhrases(rest, backchannel).length === 0) return 'resume'
  }
  return 'new'
}

const MAX_TAIL_WORDS = 14

/**
 * What to say when resuming: the interrupted sentence from its start (the part of `spoken` after
 * its last sentence break) plus everything that was never spoken. Empty when nothing is left.
 */
export function resumeText(spoken: string | undefined, unspoken: string | undefined): string {
  const rest = (unspoken ?? '').trim()
  if (!rest) return ''
  const heard = (spoken ?? '').trim()
  let tail = ''
  if (heard) {
    const m = /[.!?]["')\]]*\s+(?=[^\s])/g
    let cutAt = 0
    let hit: RegExpExecArray | null
    while ((hit = m.exec(heard))) cutAt = hit.index + hit[0].length
    tail = heard.slice(cutAt).trim()
    // a run-on heard part without punctuation: only repeat the last few words
    const words = tail.split(/\s+/).filter(Boolean)
    if (words.length > MAX_TAIL_WORDS) tail = words.slice(-MAX_TAIL_WORDS).join(' ')
    if (/[.!?]["')\]]*$/.test(tail)) tail = ''
  }
  return tail ? `${tail} ${rest}` : rest
}
