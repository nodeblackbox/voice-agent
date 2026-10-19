import { stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import type { BrainSettings, ModelInfo, SpeechSettings, StyleFormat, TurnMetrics } from '@shared/types'
import { MissingKeyError, type ModelFactory } from '../providers/factory'
import { SentenceChunker } from '../speech/chunker'
import { SpeakableFilter } from '../prompts/speakable'
import type { Speaker } from '../speech/speaker'
import { STEP_LIMIT_PHRASE, continuationFiller, fillerFor } from '../speech/fillers'

export interface RunnerDeps {
  factory: ModelFactory
  model: ModelInfo
  fallback: ModelInfo | null
  system: string
  messages: ModelMessage[]
  tools: ToolSet
  maxSteps: number
  format: StyleFormat
  speaker: Speaker
  speech: SpeechSettings
  brain: BrainSettings
  fillerEnabled: boolean
  firstTokenTimeoutMs: number
  stallTimeoutMs: number
  toolStallTimeoutMs: number
  onDelta(text: string): void
  onToolStart(id: string, name: string, input: unknown): void
  onToolEnd(id: string, name: string, ok: boolean, output: unknown, error?: string): void
  onCue(on: boolean): void
  onMetrics(m: TurnMetrics): void
  onNotice(text: string): void
  log(msg: string): void
  trace?(ev: string, data?: Record<string, unknown>): void
}

export interface RunnerResult {
  text: string
  aborted: boolean
  error?: string
  modelUsed: string
  hitStepLimit?: boolean
}

type Attempt = { model: ModelInfo; reason: string }

const status = (e: unknown): number | undefined => (e as { statusCode?: number })?.statusCode
const isTransient = (e: unknown): boolean => {
  const s = status(e)
  if (s !== undefined) return [408, 409, 429, 500, 502, 503, 504, 529].includes(s)
  const msg = String((e as Error)?.message ?? e).toLowerCase()
  return /timeout|timed out|econnreset|fetch failed|network|socket|overloaded|stall/.test(msg)
}
// a bad or revoked key for the provider itself, not a transient outage: retrying the same model is pointless, go straight to fallback
const isAuthError = (e: unknown): boolean => {
  const s = status(e)
  if (s === 401 || s === 403) return true
  const msg = String((e as Error)?.message ?? e).toLowerCase()
  return /invalid x-api-key|invalid api key|authentication_error|unauthorized/.test(msg)
}
const describe = (e: unknown): string => {
  if (e instanceof MissingKeyError) return e.message
  const s = status(e)
  const msg = String((e as Error)?.message ?? e).split('\n')[0] ?? 'unknown error'
  return s ? `${s}: ${msg}` : msg
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

export class TurnRunner {
  private text = ''
  private startedAt = performance.now()
  private metrics: TurnMetrics = {}
  private lastFillerAt = Number.NEGATIVE_INFINITY

  constructor(private readonly deps: RunnerDeps) {}

  async run(signal: AbortSignal): Promise<RunnerResult> {
    const attempts: Attempt[] = [
      { model: this.deps.model, reason: 'primary' },
      { model: this.deps.model, reason: 'retry' }
    ]
    if (this.deps.fallback && this.deps.fallback.id !== this.deps.model.id) attempts.push({ model: this.deps.fallback, reason: 'fallback' })

    let lastError: unknown
    let rotatingKey = false
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i]!
      if (signal.aborted) return { text: this.text, aborted: true, modelUsed: attempt.model.id }
      if (!rotatingKey) {
        if (attempt.reason === 'retry' && this.deps.brain.retryBackoffMs > 0) await sleep(this.deps.brain.retryBackoffMs, signal)
        if (signal.aborted) return { text: this.text, aborted: true, modelUsed: attempt.model.id }
        if (attempt.reason === 'fallback') this.deps.onNotice(`${this.deps.model.label} isn't responding, trying ${attempt.model.label}.`)
      }
      rotatingKey = false
      if (attempt.reason !== 'primary') this.deps.trace?.('turn.attempt', { reason: attempt.reason, model: attempt.model.id })
      try {
        const outcome = await this.attempt(attempt.model, signal)
        return outcome
      } catch (e) {
        lastError = e
        if (signal.aborted) return { text: this.text, aborted: true, modelUsed: attempt.model.id }
        this.deps.log(`turn attempt (${attempt.reason}, ${attempt.model.id}) failed: ${describe(e)}`)
        this.deps.trace?.('turn.attempt_failed', { reason: attempt.reason, model: attempt.model.id, error: describe(e), transient: isTransient(e) })
        if (this.text.length > 0) break
        // one dead key in the Groq pool shouldn't sink the turn: the pool benched it, try the next one
        if (isAuthError(e) && attempt.model.provider === 'groq' && this.deps.factory.groqPool.hasUsable()) {
          rotatingKey = true
          i--
          continue
        }
        if (e instanceof MissingKeyError || isAuthError(e)) {
          if (attempt.reason !== 'fallback' && this.deps.fallback) {
            // the key is bad, not the network: skip any same-model retry and go straight to fallback
            const fallbackIndex = attempts.findIndex((a) => a.reason === 'fallback')
            if (fallbackIndex > i) i = fallbackIndex - 1
            continue
          }
          break
        }
        if (!isTransient(e)) break
      }
    }
    return { text: this.text, aborted: false, error: describe(lastError), modelUsed: this.deps.model.id }
  }

  private providerOptions(info: ModelInfo): Record<string, Record<string, string>> | undefined {
    const effort = this.deps.brain.groqReasoningEffort
    if (info.provider === 'groq' && info.reasoning && effort !== 'default') return { groq: { reasoningEffort: effort } }
    return undefined
  }

  private async attempt(info: ModelInfo, outer: AbortSignal): Promise<RunnerResult> {
    const { model, key } = this.deps.factory.create(info)
    const inner = new AbortController()
    const signal = AbortSignal.any([outer, inner.signal])
    let stallReason = ''
    let timer: NodeJS.Timeout | null = null
    const arm = (ms: number, reason: string): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        stallReason = reason
        inner.abort()
      }, ms)
    }
    const disarm = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
    }

    // "Still looking." after a tool has been quiet for fillerAfterMs, once per tool call
    let continuation: NodeJS.Timeout | null = null
    const cancelContinuation = (): void => {
      if (continuation) clearTimeout(continuation)
      continuation = null
    }
    const scheduleContinuation = (toolName: string, delayMs: number): void => {
      cancelContinuation()
      continuation = setTimeout(() => {
        continuation = null
        if (signal.aborted || toolsInFlight === 0 || !this.deps.fillerEnabled) return
        const busy = this.deps.speaker.busyForMs()
        if (busy > 0) {
          scheduleContinuation(toolName, Math.max(200, busy))
          return
        }
        const text = continuationFiller()
        this.deps.trace?.('turn.filler', { kind: 'continuation', tool: toolName, text })
        this.deps.speaker.say(text, 'filler')
        this.lastFillerAt = performance.now()
      }, delayMs)
    }

    const chunker = new SentenceChunker(this.deps.speech.maxChars, this.deps.speech.firstMinWords)
    const filter = new SpeakableFilter(this.deps.format)
    let firstToken = false
    let firstSentence = false
    let toolsInFlight = 0
    let lastFinish: string | undefined
    let noteBuf = ''
    const textBefore = this.text
    const fallbackUsed = info.id !== this.deps.model.id

    try {
      arm(this.deps.firstTokenTimeoutMs, 'no response from the model')
      const result = streamText({
        model: model as LanguageModel,
        system: this.deps.system,
        messages: this.deps.messages,
        tools: this.deps.tools,
        stopWhen: stepCountIs(this.deps.maxSteps),
        abortSignal: signal,
        maxRetries: 0,
        temperature: this.deps.brain.temperature,
        maxOutputTokens: this.deps.brain.maxTokens,
        providerOptions: this.providerOptions(info)
      })

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta': {
            if (!firstToken) {
              firstToken = true
              this.metrics.ttftMs = Math.round(performance.now() - this.startedAt)
              this.deps.trace?.('turn.first_token', { ttftMs: this.metrics.ttftMs, model: info.id })
            }
            let delta = part.text
            // the model sometimes parrots the app's bracketed bookkeeping ("[interrupted …]"); never speak it
            if (!this.text.trim()) {
              noteBuf += delta
              const m = /^\s*\[[^\]]{0,200}\]\s*/.exec(noteBuf)
              if (m) {
                this.deps.trace?.('turn.note_echo', { note: m[0].trim() })
                delta = noteBuf.slice(m[0].length).trimStart()
                noteBuf = ''
              } else if (noteBuf.trimStart().startsWith('[') && noteBuf.length < 220 && !noteBuf.includes(']')) {
                arm(this.deps.stallTimeoutMs, 'the model stopped mid-answer')
                break
              } else {
                delta = noteBuf.trimStart()
                noteBuf = ''
              }
              if (!delta) {
                arm(this.deps.stallTimeoutMs, 'the model stopped mid-answer')
                break
              }
            }
            this.text += delta
            this.deps.onDelta(delta)
            for (const sentence of chunker.feed(filter.feed(delta))) {
              if (!firstSentence) {
                firstSentence = true
                this.metrics.ttfsMs = Math.round(performance.now() - this.startedAt)
                this.deps.trace?.('turn.first_sentence', { ttfsMs: this.metrics.ttfsMs, chars: sentence.length })
              }
              this.deps.speaker.say(sentence)
            }
            arm(this.deps.stallTimeoutMs, 'the model stopped mid-answer')
            break
          }
          case 'tool-call': {
            toolsInFlight++
            this.deps.onToolStart(part.toolCallId, part.toolName, part.input)
            if (this.deps.fillerEnabled) {
              const now = performance.now()
              // flush whatever the model said before the call so the lead-in follows it immediately
              for (const s of chunker.flush()) this.deps.speaker.say(s)
              if (now - this.lastFillerAt >= this.deps.speech.fillerMinGapMs) {
                const filler = fillerFor(part.toolName)
                this.deps.trace?.('turn.filler', { kind: 'lead-in', tool: part.toolName, text: filler })
                this.deps.speaker.say(filler, 'filler')
                this.lastFillerAt = now
              }
              scheduleContinuation(part.toolName, this.deps.speech.fillerAfterMs)
            }
            this.deps.onCue(true)
            arm(this.deps.toolStallTimeoutMs, `the ${part.toolName} tool took too long`)
            break
          }
          case 'tool-result': {
            toolsInFlight = Math.max(0, toolsInFlight - 1)
            this.deps.onToolEnd(part.toolCallId, part.toolName, true, part.output)
            if (toolsInFlight === 0) {
              this.deps.onCue(false)
              cancelContinuation()
            }
            arm(this.deps.stallTimeoutMs, 'the model stopped after a tool call')
            break
          }
          case 'tool-error': {
            toolsInFlight = Math.max(0, toolsInFlight - 1)
            this.deps.onToolEnd(part.toolCallId, part.toolName, false, undefined, describe(part.error))
            if (toolsInFlight === 0) {
              this.deps.onCue(false)
              cancelContinuation()
            }
            arm(this.deps.stallTimeoutMs, 'the model stopped after a tool error')
            break
          }
          case 'finish-step': {
            this.metrics.steps = (this.metrics.steps ?? 0) + 1
            lastFinish = part.finishReason
            const u = part.usage as { inputTokens?: number | { total?: number }; outputTokens?: number | { total?: number } } | undefined
            const total = (v: number | { total?: number } | undefined): number => (typeof v === 'number' ? v : (v?.total ?? 0))
            this.metrics.inputTokens = (this.metrics.inputTokens ?? 0) + total(u?.inputTokens)
            this.metrics.outputTokens = (this.metrics.outputTokens ?? 0) + total(u?.outputTokens)
            break
          }
          case 'error':
            throw part.error
          case 'abort':
            break
          default:
            break
        }
      }
      disarm()
      cancelContinuation()
      if (inner.signal.aborted && !outer.aborted) throw new Error(`stall: ${stallReason}`)
      if (noteBuf && !this.text.trim()) {
        // an unterminated "[" run at the very start: it was text after all
        this.text += noteBuf
        this.deps.onDelta(noteBuf)
        chunker.feed(filter.feed(noteBuf))
        noteBuf = ''
      }
      for (const s of chunker.flush()) this.deps.speaker.say(s)
      let hitStepLimit = false
      if (lastFinish === 'tool-calls' && (this.metrics.steps ?? 0) >= this.deps.maxSteps) {
        // the model still wanted tools when the round cap hit: say so only if it said nothing else
        hitStepLimit = true
        this.deps.trace?.('turn.step_limit', { steps: this.metrics.steps, maxSteps: this.deps.maxSteps, spoke: this.text.length > 0 })
        if (!this.text.trim()) {
          this.text += STEP_LIMIT_PHRASE
          this.deps.onDelta(STEP_LIMIT_PHRASE)
          this.deps.speaker.say(STEP_LIMIT_PHRASE)
        }
      }
      if (info.provider === 'groq') this.deps.factory.groqPool.report(key, 200)
      this.metrics.totalMs = Math.round(performance.now() - this.startedAt)
      this.metrics.model = info.id
      if (fallbackUsed) this.metrics.fallbackUsed = true
      if (hitStepLimit) this.metrics.hitStepLimit = true
      this.deps.onMetrics(this.metrics)
      return { text: this.text, aborted: outer.aborted, modelUsed: info.id, hitStepLimit }
    } catch (e) {
      disarm()
      cancelContinuation()
      this.deps.onCue(false)
      if (info.provider === 'groq') {
        const s = status(e)
        if (s) this.deps.factory.groqPool.report(key, s)
      }
      if (outer.aborted) return { text: this.text, aborted: true, modelUsed: info.id }
      if (inner.signal.aborted) {
        this.deps.trace?.('turn.stall', { reason: stallReason, model: info.id, chars: this.text.length })
        if (this.text.length > textBefore.length) {
          for (const s of chunker.flush()) this.deps.speaker.say(s)
          this.deps.onNotice(`Response cut short: ${stallReason}.`)
          this.metrics.model = info.id
          this.metrics.stallReason = stallReason
          if (fallbackUsed) this.metrics.fallbackUsed = true
          this.deps.onMetrics(this.metrics)
          return { text: this.text, aborted: false, error: stallReason, modelUsed: info.id }
        }
        throw new Error(`timeout: ${stallReason}`)
      }
      throw e
    }
  }
}
