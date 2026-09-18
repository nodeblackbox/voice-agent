// The session trace: one JSON object per line in logs/sessions/<sessionId>.jsonl. Every event that
// matters for reconstructing a turn goes through here; per-frame data (VAD levels) never does.
// docs/DEBUGGING.md lists the vocabulary.

export interface TraceEvent {
  /** Dotted event name: state, ear.final, turn.start, tts.sentence, playback.started, sidecar.ready … */
  ev: string
  /** Session the event belongs to; omitted for process-level events, which land in the current session. */
  sid?: string
  turn?: string
  t?: string
  [key: string]: unknown
}

export type Trace = (event: TraceEvent) => void

export const TRANSCRIPT_FIELDS = new Set(['text', 'spokenText', 'unspokenText', 'partial', 'userText', 'memoryBlock', 'system', 'hints', 'summary', 'detail'])

/** Replace spoken/typed text with its length so a trace can be shared without the conversation. */
export function redactTranscript(e: TraceEvent): TraceEvent {
  const out: TraceEvent = { ...e }
  for (const k of TRANSCRIPT_FIELDS) {
    if (!(k in out)) continue
    const v = out[k]
    out[k] = typeof v === 'string' ? `[${v.length} chars]` : Array.isArray(v) ? `[${v.length} items]` : '[redacted]'
  }
  return out
}

export const noTrace: Trace = () => undefined
