// Every number that decides how the agent *feels* lives here, once. Settings defaults, the
// Settings UI, the sidecar config message and docs/TUNING.md are all derived from this table.
// `scope` names the process that consumes a parameter; `restart` marks the few that only apply
// on the next launch. `old` is the value the original Python agent shipped with, for reference.

export type TuningScope = 'ear' | 'core' | 'renderer' | 'main'

interface ParamBase {
  label: string
  doc: string
  scope: TuningScope
  restart?: boolean
  old?: number | string | boolean
  /**
   * Defaults this parameter had in earlier builds. A stored value equal to one of them is treated as
   * "never touched" and replaced by the current default at load, so a changed default reaches users
   * whose settings file was written by the old build. Add the old value here whenever `default` changes.
   */
  superseded?: ReadonlyArray<number | string | boolean>
}

export interface NumberParam extends ParamBase {
  kind: 'number'
  default: number
  min: number
  max: number
  step: number
  unit?: string
}

export interface BoolParam extends ParamBase {
  kind: 'boolean'
  default: boolean
}

export interface EnumParam extends ParamBase {
  kind: 'enum'
  default: string
  options: readonly string[]
}

/** Free text, e.g. a comma-separated word list. */
export interface TextParam extends ParamBase {
  kind: 'text'
  default: string
  maxChars?: number
}

export type TuningParam = NumberParam | BoolParam | EnumParam | TextParam

export const DEFAULT_FILLER_WORDS =
  "um, umm, uh, uhh, er, ah, so, and, but, or, the, a, is, that, that's, like, because, which, yeah, well, wait, if, i, you, we, it's, with, for, to, then, basically, also, maybe, where, when, what, how, why, i'll, i'm, i've, we're, it'll, gonna, wanna, of, in, on, at, by, from, about, into, my, your, his, her, our, their, this, these, those, some, kind, sort, mean, really, actually, just, very"

const n = (
  def: number,
  min: number,
  max: number,
  step: number,
  scope: TuningScope,
  label: string,
  doc: string,
  extra: { unit?: string; restart?: boolean; old?: number; superseded?: readonly number[] } = {}
): NumberParam => ({ kind: 'number', default: def, min, max, step, scope, label, doc, ...extra })

export const TUNING = {
  endpoint: {
    vadThreshold: n(0.5, 0.2, 0.9, 0.05, 'ear', 'VAD threshold', 'Silero speech probability that opens an utterance while listening. Lower catches quiet speech but breaths and keyboard clicks start false turns.', { unit: 'p', old: 0.5 }),
    minSpeechMs: n(250, 100, 800, 50, 'ear', 'Min speech', 'Total speech needed before an utterance counts. Shorter bursts are blips: dropped silently, never sent to ASR.', { unit: 'ms', old: 250 }),
    minSilenceMs: n(250, 100, 800, 50, 'ear', 'Min silence', 'Silence before Smart Turn starts scoring. This is the floor of end-of-turn latency; below it the model never runs.', { unit: 'ms', old: 250 }),
    maxSilenceMs: n(1500, 600, 4000, 100, 'ear', 'Max silence', 'Hard end of turn after this much silence while Smart Turn is unsure (score between the low and the done thresholds). Safety net so a mis-scoring model cannot hang a turn.', { unit: 'ms', old: 1200, superseded: [1200] }),
    checkEveryMs: n(200, 100, 500, 50, 'ear', 'Check every', 'Minimum additional silence between Smart Turn checks. Each check costs 10-30 ms of CPU on the 8 s window.', { unit: 'ms', old: 200 }),
    turnThreshold: n(0.7, 0.4, 0.95, 0.05, 'ear', 'Turn threshold', 'Smart Turn probability below which the turn never ends. Raise if it cuts you off, lower if it waits too long after clear endings.', { unit: 'p', old: 0.7 }),
    turnHighThreshold: n(0.9, 0.6, 1, 0.05, 'ear', 'Turn high threshold', 'At or above this the turn ends even if the live partial ends on a filler word (um, so, and), except once per utterance when "Filler holds high tier" is on. Between the two thresholds a trailing filler always holds the turn open.', { unit: 'p', old: 0.9 }),
    turnLowThreshold: n(0.3, 0.05, 0.6, 0.05, 'ear', 'Turn low threshold', 'Below this Smart Turn is sure you are mid-thought: the silence cap becomes "Max silence (thinking)" instead of "Max silence", so a pause to think does not end the turn.', { unit: 'p' }),
    maxSilenceLowMs: n(3000, 1000, 8000, 250, 'ear', 'Max silence (thinking)', 'How long a pause may last while Smart Turn says you are not done. The cost of raising it is a slower reply only when you really did stop on a low score.', { unit: 'ms' }),
    silencePartialMs: n(100, 32, 400, 16, 'ear', 'Partial on pause after', 'A pause this long forces one partial transcript, so the filler-word guard reads your actual last word instead of a caption up to "Partials every" old.', { unit: 'ms' }),
    fillerWords: { kind: 'text', default: DEFAULT_FILLER_WORDS, maxChars: 2000, scope: 'ear', label: 'Filler words', doc: 'Comma-separated words that mean "not finished" when a pause lands right after them (um, so, and, then, basically, I\'ll…). Also used by the app to merge a fragment with what you say next.' },
    fillerHoldsHighTier: { kind: 'boolean', default: true, scope: 'ear', label: 'Filler holds high tier', doc: 'When on, a trailing filler word holds the turn once even at a confident score; the next check 200 ms later decides. Off = the old behaviour (confident score always ends the turn).' },
    bargeInThreshold: n(0.75, 0.4, 0.95, 0.05, 'ear', 'Barge-in VAD', 'Speech probability counted as a hit while the agent is speaking or thinking. Higher than the VAD threshold so speaker bleed and room noise do not build barge-in credit.', { unit: 'p', old: 0.75 }),
    bargeInInstant: { kind: 'boolean', default: true, scope: 'ear', label: 'Stop instantly on speech', doc: 'You always have priority: the agent is cut as soon as "Duck chunks" of speech credit build up (about 100 ms), with no ducked phase and no release. A backchannel also cuts; the app then resumes the reply from the cut sentence by itself. Off = the staged duck → cut → release behaviour.' },
    bargeInChunks: n(10, 3, 30, 1, 'ear', 'Barge-in chunks', 'Staged mode only: net 32 ms speech credits needed to cut the agent (10 = about 320 ms of sustained speech).', { unit: 'frames', old: 10 }),
    duckChunks: n(3, 1, 10, 1, 'ear', 'Duck chunks', 'Credits before the agent stops (instant mode) or playback is ducked (staged mode). 3 = about 100 ms. With open speakers and self-cuts, raise this before touching anything else.', { unit: 'frames', old: 3 }),
    duckGain: n(0.25, 0, 1, 0.05, 'renderer', 'Duck gain', 'Playback volume while ducked, applied by the renderer with a short ramp.', { unit: 'x', old: 0.25 }),
    bargeInDecay: n(1, 0, 5, 1, 'ear', 'Barge-in decay', 'Credit lost per quiet frame. 1 means a natural mid-word VAD dip barely costs anything; a hard reset (old behaviour) never cut on real, fluttery speech.', { unit: 'credits', old: 1 }),
    bargeInReleaseChunks: n(6, 2, 20, 1, 'ear', 'Release chunks', 'Staged mode only: consecutive quiet frames after a duck before it is called a finished backchannel and volume is restored (6 = about 190 ms). Avoids duck/undock flicker inside one utterance.', { unit: 'frames', old: 6 }),
    partialEveryMs: n(600, 300, 2000, 100, 'ear', 'Partials every', 'New audio between live partial transcripts. Partials drive the captions and the filler-word guard, so slower partials mean a staler guard.', { unit: 'ms', old: 600, superseded: [700] }),
    prerollMs: n(1000, 200, 2000, 100, 'ear', 'Preroll', 'Audio kept before speech is detected and prepended to the utterance so the first syllable is not clipped. Must exceed bargeInChunks x 32 ms or the first word after an interruption is lost.', { unit: 'ms', old: 1000 }),
    maxUtteranceMs: n(120000, 10000, 300000, 5000, 'ear', 'Max utterance', 'Absolute cap on one utterance. Long monologues are transcribed in segments before this (see "Segment every"), so this only stops a stuck microphone.', { unit: 'ms', old: 30000, superseded: [30000] }),
    segmentEveryMs: n(30000, 10000, 120000, 5000, 'ear', 'Segment every', 'While you keep talking, the older part of the utterance is transcribed every this often and shown in your bubble; the turn does not end. Lower = your words appear sooner; each segment costs one decode.', { unit: 'ms' })
  },
  brain: {
    firstTokenTimeoutMs: n(8000, 2000, 30000, 500, 'core', 'First token timeout', 'Give up on a model that has produced nothing after this long; retry once, then the fallback model.', { unit: 'ms', old: 8000 }),
    stallTimeoutMs: n(8000, 2000, 30000, 500, 'core', 'Stall timeout', 'Abandon a reply that stops mid-stream for this long. What was already spoken is kept and the transcript says the response was cut short.', { unit: 'ms', old: 8000 }),
    toolStallTimeoutMs: n(25000, 5000, 120000, 1000, 'core', 'Tool stall timeout', 'Stall timeout while a tool call is in flight; searches and page reads legitimately take longer than token gaps.', { unit: 'ms', old: 25000 }),
    retryBackoffMs: n(400, 0, 3000, 100, 'core', 'Retry backoff', 'Pause before retrying the same model after a transient error (overloaded, 5xx).', { unit: 'ms', old: 400 }),
    maxStepsAsk: n(4, 1, 8, 1, 'core', 'Max steps (Ask)', 'Tool rounds allowed per turn in Ask mode: a recall plus a couple of memory edits needs three or four. When the cap is hit before the model said anything, the agent says so instead of ending silently.', { unit: 'steps', superseded: [2] }),
    maxStepsAgent: n(8, 1, 20, 1, 'core', 'Max steps (Agent)', 'Tool rounds allowed per turn in Agent mode.', { unit: 'steps' }),
    historyMessages: n(40, 4, 200, 2, 'core', 'History messages', 'Most recent messages sent to the model each turn. Tool results inside them are compacted separately.', { unit: 'messages' }),
    minUtteranceChars: n(2, 1, 10, 1, 'core', 'Min utterance chars', 'Final transcripts shorter than this are dropped without a turn.', { unit: 'chars' }),
    toolResultKeepChars: n(700, 100, 4000, 50, 'core', 'Tool result keep', 'Characters of each tool result kept in history for later turns. The model already used the full result; this keeps context lean and fast.', { unit: 'chars', old: 700 }),
    temperature: n(0.6, 0, 1.5, 0.05, 'core', 'Temperature', 'Sampling temperature for the reply.', { old: 0.6 }),
    maxTokens: n(1000, 100, 4000, 50, 'core', 'Max tokens', 'Output token cap per model call. Spoken replies rarely need more than a few hundred; comprehensive styles need headroom.', { unit: 'tokens', old: 300 }),
    groqReasoningEffort: { kind: 'enum', default: 'low', options: ['low', 'medium', 'high', 'default'], scope: 'core', label: 'Groq reasoning effort', doc: 'Reasoning budget for Groq reasoning models (gpt-oss, qwen). Voice cannot wait for long thinking, so low is the default.', old: 'low' },
    continuationWindowMs: n(2500, 0, 6000, 250, 'core', 'Continuation window', 'If a transcript looks unfinished (ends on a filler word, fewer than "Merge min words", or a timeout on a low score) and you start speaking again within this long, the reply is cancelled silently and the two pieces become one turn. 0 disables merging.', { unit: 'ms' }),
    mergeMinWords: n(4, 1, 10, 1, 'core', 'Merge min words', 'Transcripts shorter than this always count as unfinished for the continuation window ("Yeah, so basically").', { unit: 'words' }),
    mergeHoldMs: n(0, 0, 2000, 100, 'core', 'Hold reply when unfinished', 'Wait this long before sending an unfinished-looking transcript to the model, so a continuation merges without ever starting a reply. Costs latency on real endings that happen to look unfinished; 0 = reply immediately and cancel if you continue.', { unit: 'ms' }),
    uiFlushMs: n(40, 0, 500, 10, 'core', 'UI flush interval', 'How often a streaming reply is pushed to the transcript and saved while tokens arrive. Every token used to be a full transcript re-render, which starved audio playback in long sessions. 0 = every token.', { unit: 'ms' })
  },
  speech: {
    firstMinWords: n(4, 0, 15, 1, 'core', 'First clause min words', 'The first chunk of a reply may be cut at a comma/colon/dash once it has this many words, so speech starts before the first full sentence. 0 disables.', { unit: 'words', old: 6, superseded: [6] }),
    maxChars: n(220, 80, 600, 10, 'core', 'Max sentence chars', 'Run-on sentences are force-cut at the last comma or space past this length so a long sentence cannot stall first audio.', { unit: 'chars', old: 220 }),
    fillerAfterMs: n(1500, 300, 6000, 100, 'core', 'Continuation filler after', 'If a tool is still running and nothing has been spoken for this long, say one short filler ("Still looking.") so the agent never goes dead quiet.', { unit: 'ms', old: 1500 }),
    fillerMinGapMs: n(4000, 0, 20000, 500, 'core', 'Filler min gap', 'Skip the lead-in filler for a tool call if another filler was spoken more recently than this.', { unit: 'ms' }),
    ttsPoolSize: n(3, 1, 6, 1, 'core', 'TTS pool size', 'Edge TTS sockets kept open; also the number of sentences synthesized ahead of playback.', { unit: 'sockets', restart: true }),
    ttsTimeoutMs: n(12000, 3000, 30000, 500, 'core', 'TTS timeout', 'Give up on one sentence of Edge TTS after this long.', { unit: 'ms' }),
    ttsAttempts: n(2, 1, 4, 1, 'core', 'TTS attempts', 'Tries per sentence before it is skipped.', { unit: 'tries' }),
    ttsDegradeAfter: n(3, 1, 10, 1, 'core', 'TTS degrade after', 'Consecutive failed sentences before the rest of the turn uses the system voice.', { unit: 'failures' })
  },
  playback: {
    duckRampMs: n(60, 10, 500, 10, 'renderer', 'Duck ramp', 'Gain ramp time when ducking or restoring playback volume.', { unit: 'ms' }),
    gapMs: n(20, 0, 200, 5, 'renderer', 'Chunk gap', 'Minimum scheduling lead between consecutive audio chunks.', { unit: 'ms' })
  },
  memory: {
    profileLimit: n(40, 0, 200, 5, 'core', 'Profile entries', 'Profile memory entries always injected into the prompt.', { unit: 'entries' }),
    relevantLimit: n(6, 0, 20, 1, 'core', 'Relevant entries', 'BM25 memory hits for the current utterance injected into the prompt.', { unit: 'entries' }),
    relevantMinScore: n(0, 0, 20, 0.5, 'core', 'Relevant min score', 'Minimum |bm25| rank for a memory hit to be injected. 0 disables the filter and always injects the top hits.', { unit: 'score' }),
    historyHits: n(3, 0, 10, 1, 'core', 'History hits', 'Past-session messages matching the utterance injected as hints.', { unit: 'messages', old: 3 }),
    hintMaxChars: n(200, 40, 1000, 20, 'core', 'Hint max chars', 'Each injected memory or history hint is truncated to this length.', { unit: 'chars', old: 200 })
  },
  runtime: {
    idleShutdownMs: n(300000, 0, 3600000, 60000, 'main', 'Ear idle shutdown', 'Unload the ear models after the microphone has been off this long. 0 never unloads. A restart is a full cold load.', { unit: 'ms' }),
    levelEveryFrames: n(3, 1, 30, 1, 'ear', 'Level meter every', 'Frames between VAD level events for the meter (3 = about 10 Hz). Never written to logs.', { unit: 'frames' }),
    asrFailureLimit: n(3, 1, 10, 1, 'ear', 'ASR failures before reload', 'Consecutive failed decodes (typically a CUDA allocation error when another app took the VRAM) before the ears reload the speech model once; failing again after that restarts the ears.', { unit: 'failures' }),
    logTranscripts: { kind: 'boolean', default: true, scope: 'main', label: 'Log transcripts', doc: 'Include what was said (user and agent text) in the session trace files on disk.' },
    logLevel: { kind: 'enum', default: 'info', options: ['debug', 'info', 'warn', 'error'], scope: 'main', label: 'Log level', doc: 'Minimum level written to app.log. errors.log always gets warn and above.' }
  }
} as const satisfies Record<string, Record<string, TuningParam>>

export type TuningGroup = keyof typeof TUNING

type ParamValue<P> = P extends { kind: 'number' } ? number : P extends { kind: 'boolean' } ? boolean : P extends { options: readonly (infer O)[] } ? O : never

export type TuningValues = { [G in TuningGroup]: { [K in keyof (typeof TUNING)[G]]: ParamValue<(typeof TUNING)[G][K]> } }

export const TUNING_GROUP_INFO: Record<TuningGroup, { label: string; doc: string }> = {
  endpoint: { label: 'Ears: turn taking and barge-in', doc: 'Silero VAD, Smart Turn end-of-turn scoring and the barge-in credit bucket. Applied live to the sidecar.' },
  brain: { label: 'Brain: model calls', doc: 'Timeouts, retries, step caps and history depth for the LLM loop. Applied on the next turn.' },
  speech: { label: 'Speech: sentences and fillers', doc: 'Sentence chunking, filler phrases and Edge TTS resilience.' },
  playback: { label: 'Playback', doc: 'Renderer audio scheduling and ducking.' },
  memory: { label: 'Memory injection', doc: 'How much remembered context is put in front of the model each turn.' },
  runtime: { label: 'Runtime and logging', doc: 'Process lifecycle and what gets written to disk.' }
}

export function defaultTuning(): TuningValues {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [g, params] of Object.entries(TUNING)) {
    out[g] = {}
    for (const [k, p] of Object.entries(params as Record<string, TuningParam>)) out[g]![k] = p.default
  }
  return out as TuningValues
}

export const DEFAULT_TUNING: TuningValues = defaultTuning()

export const TUNING_GROUPS = Object.keys(TUNING) as TuningGroup[]

export function tuningParams(group: TuningGroup): Array<{ key: string; param: TuningParam }> {
  return Object.entries(TUNING[group] as Record<string, TuningParam>).map(([key, param]) => ({ key, param }))
}

/** Clamp/validate a raw value against its parameter definition; returns the default when unusable. */
export function coerceParam(param: TuningParam, value: unknown): number | boolean | string {
  if (param.kind === 'number') {
    const v = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(v)) return param.default
    return Math.min(param.max, Math.max(param.min, v))
  }
  if (param.kind === 'boolean') return typeof value === 'boolean' ? value : param.default
  if (param.kind === 'text') return typeof value === 'string' ? value.slice(0, param.maxChars ?? 2000) : param.default
  return typeof value === 'string' && param.options.includes(value) ? value : param.default
}

/** Every parameter the ear sidecar consumes, flattened into the `config.endpoint` message. */
export function earConfig(values: TuningValues): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {}
  for (const g of TUNING_GROUPS) {
    for (const { key, param } of tuningParams(g)) {
      if (param.scope === 'ear' || g === 'endpoint') out[key] = (values[g] as Record<string, number | boolean | string>)[key]!
    }
  }
  return out
}

export interface TuningDiff {
  group: TuningGroup
  key: string
  value: number | boolean | string
  default: number | boolean | string
}

export function tuningDiff(values: TuningValues): TuningDiff[] {
  const out: TuningDiff[] = []
  for (const g of TUNING_GROUPS) {
    for (const { key, param } of tuningParams(g)) {
      const v = (values[g] as Record<string, number | boolean | string>)[key]
      if (v !== undefined && v !== param.default) out.push({ group: g, key, value: v, default: param.default })
    }
  }
  return out
}

export function pickTuning<T extends TuningValues>(settings: T): TuningValues {
  const out: Record<string, unknown> = {}
  for (const g of TUNING_GROUPS) out[g] = { ...(settings[g] as object) }
  return out as TuningValues
}

export interface TuningMigration {
  group: TuningGroup
  key: string
  from: number | boolean | string
  to: number | boolean | string
}

/**
 * Merge an imported or stored profile over the defaults, dropping unknown keys and clamping the rest.
 * A stored value that equals a `superseded` default is replaced by the current default and reported
 * through `onMigrate`, so a default changed in a newer build reaches settings files written by an older one.
 */
export function sanitizeTuning(raw: unknown, onMigrate?: (m: TuningMigration) => void): TuningValues {
  const out = defaultTuning()
  if (!raw || typeof raw !== 'object') return out
  for (const g of TUNING_GROUPS) {
    const group = (raw as Record<string, unknown>)[g]
    if (!group || typeof group !== 'object') continue
    for (const { key, param } of tuningParams(g)) {
      const v = (group as Record<string, unknown>)[key]
      if (v === undefined) continue
      const coerced = coerceParam(param, v)
      if (param.superseded?.includes(coerced) && coerced !== param.default) {
        onMigrate?.({ group: g, key, from: coerced, to: param.default })
        continue
      }
      ;(out[g] as Record<string, unknown>)[key] = coerced
    }
  }
  return out
}

/**
 * The tuning groups of `settings` with every value that equals its default removed: what gets written
 * to disk, so a stored file only pins what the user actually changed and new defaults propagate.
 */
export function stripTuningDefaults<T extends TuningValues>(settings: T): T {
  const out = { ...settings } as Record<string, unknown>
  for (const g of TUNING_GROUPS) {
    const group = settings[g] as Record<string, unknown> | undefined
    if (!group) continue
    const kept: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(group)) {
      const param = (TUNING[g] as Record<string, TuningParam | undefined>)[k]
      if (!param || v !== param.default) kept[k] = v
    }
    out[g] = kept
  }
  return out as T
}
