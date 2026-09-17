import { stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import type { ModelInfo, TurnMetrics } from '@shared/types'
import { MissingKeyError, type ModelFactory } from '../providers/factory'
import { SentenceChunker } from '../speech/chunker'
import { SpeakableFilter } from '../prompts/speakable'
import type { Speaker } from '../speech/speaker'
import { fillerFor } from '../speech/fillers'
import type { StyleFormat } from '@shared/types'

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
}

export interface RunnerResult {
  text: string
  aborted: boolean
  error?: string
  modelUsed: string
}

type Attempt = { model: ModelInfo; reason: string }

const status = (e: unknown): number | undefined => (e as { statusCode?: number })?.statusCode
const isTransient = (e: unknown): boolean => {
  const s = status(e)
  if (s !== undefined) return [408, 409, 429, 500, 502, 503, 504, 529].includes(s)
  const msg = String((e as Error)?.message ?? e).toLowerCase()
  return /timeout|timed out|econnreset|fetch failed|network|socket|overloaded|stall/.test(msg)
}
const describe = (e: unknown): string => {
  if (e instanceof MissingKeyError) return e.message
  const s = status(e)
  const msg = String((e as Error)?.message ?? e).split('\n')[0] ?? 'unknown error'
  return s ? `${s}: ${msg}` : msg
}

export class TurnRunner {
  private text = ''
  private startedAt = performance.now()
  private metrics: TurnMetrics = {}

  constructor(private readonly deps: RunnerDeps) {}

  async run(signal: AbortSignal): Promise<RunnerResult> {
    const attempts: Attempt[] = [
      { model: this.deps.model, reason: 'primary' },
      { model: this.deps.model, reason: 'retry' }
    ]
    if (this.deps.fallback && this.deps.fallback.id !== this.deps.model.id) attempts.push({ model: this.deps.fallback, reason: 'fallback' })

    let lastError: unknown
    for (const attempt of attempts) {
      if (signal.aborted) return { text: this.text, aborted: true, modelUsed: attempt.model.id }
      if (attempt.reason === 'fallback') this.deps.onNotice(`${this.deps.model.label} isn't responding, trying ${attempt.model.label}.`)
      try {
        const outcome = await this.attempt(attempt.model, signal)
        return outcome
      } catch (e) {
        lastError = e
        if (signal.aborted) return { text: this.text, aborted: true, modelUsed: attempt.model.id }
        this.deps.log(`turn attempt (${attempt.reason}, ${attempt.model.id}) failed: ${describe(e)}`)
        if (this.text.length > 0) break
        if (e instanceof MissingKeyError) {
          if (attempt.reason !== 'fallback' && this.deps.fallback) continue
          break
        }
        if (!isTransient(e)) break
      }
    }
    return { text: this.text, aborted: false, error: describe(lastError), modelUsed: this.deps.model.id }
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

    const chunker = new SentenceChunker()
    const filter = new SpeakableFilter(this.deps.format)
    let firstToken = false
    let firstSentence = false
    let toolsInFlight = 0
    let fillerSaid = false
    const textBefore = this.text

    try {
      arm(this.deps.firstTokenTimeoutMs, 'no response from the model')
      const result = streamText({
        model: model as LanguageModel,
        system: this.deps.system,
        messages: this.deps.messages,
        tools: this.deps.tools,
        stopWhen: stepCountIs(this.deps.maxSteps),
        abortSignal: signal,
        maxRetries: 0
      })

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta': {
            if (!firstToken) {
              firstToken = true
              this.metrics.ttftMs = Math.round(performance.now() - this.startedAt)
            }
            this.text += part.text
            this.deps.onDelta(part.text)
            for (const sentence of chunker.feed(filter.feed(part.text))) {
              if (!firstSentence) {
                firstSentence = true
                this.metrics.ttfsMs = Math.round(performance.now() - this.startedAt)
              }
              this.deps.speaker.say(sentence)
            }
            arm(this.deps.stallTimeoutMs, 'the model stopped mid-answer')
            break
          }
          case 'tool-call': {
            toolsInFlight++
            this.deps.onToolStart(part.toolCallId, part.toolName, part.input)
            if (this.deps.fillerEnabled && !fillerSaid) {
              fillerSaid = true
              for (const s of chunker.flush()) this.deps.speaker.say(s)
              this.deps.speaker.say(fillerFor(part.toolName))
            }
            this.deps.onCue(true)
            arm(this.deps.toolStallTimeoutMs, `the ${part.toolName} tool took too long`)
            break
          }
          case 'tool-result': {
            toolsInFlight = Math.max(0, toolsInFlight - 1)
            this.deps.onToolEnd(part.toolCallId, part.toolName, true, part.output)
            if (toolsInFlight === 0) this.deps.onCue(false)
            arm(this.deps.stallTimeoutMs, 'the model stopped after a tool call')
            break
          }
          case 'tool-error': {
            toolsInFlight = Math.max(0, toolsInFlight - 1)
            this.deps.onToolEnd(part.toolCallId, part.toolName, false, undefined, describe(part.error))
            if (toolsInFlight === 0) this.deps.onCue(false)
            arm(this.deps.stallTimeoutMs, 'the model stopped after a tool error')
            break
          }
          case 'finish-step': {
            this.metrics.steps = (this.metrics.steps ?? 0) + 1
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
      if (inner.signal.aborted && !outer.aborted) throw new Error(`stall: ${stallReason}`)
      for (const s of chunker.flush()) this.deps.speaker.say(s)
      if (info.provider === 'groq') this.deps.factory.groqPool.report(key, 200)
      this.metrics.totalMs = Math.round(performance.now() - this.startedAt)
      this.metrics.model = info.id
      this.deps.onMetrics(this.metrics)
      return { text: this.text, aborted: outer.aborted, modelUsed: info.id }
    } catch (e) {
      disarm()
      this.deps.onCue(false)
      if (info.provider === 'groq') {
        const s = status(e)
        if (s) this.deps.factory.groqPool.report(key, s)
      }
      if (outer.aborted) return { text: this.text, aborted: true, modelUsed: info.id }
      if (inner.signal.aborted) {
        if (this.text.length > textBefore.length) {
          for (const s of chunker.flush()) this.deps.speaker.say(s)
          this.deps.onNotice(`Response cut short: ${stallReason}.`)
          this.metrics.model = info.id
          this.deps.onMetrics(this.metrics)
          return { text: this.text, aborted: false, error: stallReason, modelUsed: info.id }
        }
        throw new Error(`timeout: ${stallReason}`)
      }
      throw e
    }
  }
}
