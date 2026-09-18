import type { AudioChunk, VoiceSettings } from '@shared/types'
import { DEFAULT_TUNING } from '@shared/tuning'
import { isAbort, type TtsEngine } from './tts'

export interface SpeakerDeps {
  silent?: boolean
  engine: TtsEngine
  fallback: TtsEngine
  voice: VoiceSettings
  /** Tries per sentence before it is skipped. */
  attempts?: number
  /** Consecutive failed sentences before the rest of the turn uses the fallback engine. */
  degradeAfter?: number
  emit(chunk: AudioChunk): void
  onDegraded(): void
  log(msg: string): void
  trace?(ev: string, data?: Record<string, unknown>): void
}

type Kind = AudioChunk['kind']
type Item = { seq: number; text: string; kind: Kind; result: Promise<Buffer | null | 'skip'> }

/** Rough speaking rate used to estimate how long emitted audio keeps the speaker busy. */
const CHARS_PER_SECOND = 15

// One per assistant turn: sentences go in, ordered AudioChunks come out. Synthesis runs
// concurrently (bounded by the engine pool) but emission is strictly in sequence so the
// `last` flag always lands on the highest seq.
export class Speaker {
  private seq = 0
  private queue: Item[] = []
  private finished = false
  private pumping = false
  private emittedLast = false
  private consecutiveFailures = 0
  private degraded = false
  private busyUntil = 0
  private resolveDone!: () => void
  readonly done = new Promise<void>((r) => (this.resolveDone = r))
  /** Fillers spoken this turn. */
  fillers = 0
  /** Synthesis time of the first speech sentence (request -> full audio), once known. */
  firstSynthMs: number | undefined
  /** Request -> first audio byte for the first speech sentence, once known. */
  firstByteMs: number | undefined

  constructor(
    readonly turnId: string,
    private readonly deps: SpeakerDeps,
    private readonly signal: AbortSignal
  ) {}

  say(text: string, kind: Kind = 'speech'): void {
    const clean = text.trim()
    if (!clean || this.finished || this.signal.aborted || this.deps.silent) return
    const seq = this.seq++
    if (kind === 'filler') this.fillers++
    const result = this.synth(clean, seq, kind)
    result.catch(() => undefined)
    this.queue.push({ seq, text: clean, kind, result })
    void this.pump()
  }

  finish(): Promise<void> {
    this.finished = true
    void this.pump()
    return this.done
  }

  /** Estimated milliseconds until everything emitted so far has finished playing. */
  busyForMs(now = performance.now()): number {
    if (this.queue.length) return Math.max(500, this.busyUntil - now)
    return Math.max(0, this.busyUntil - now)
  }

  /** True when nothing is queued and the audio emitted so far should have finished playing. */
  isIdle(now = performance.now()): boolean {
    return this.busyForMs(now) === 0
  }

  private async synth(text: string, seq: number, kind: Kind): Promise<Buffer | null | 'skip'> {
    const t0 = performance.now()
    let firstByte: number | undefined
    const req = {
      text,
      voice: this.deps.voice.voice,
      rate: this.deps.voice.rate,
      pitch: this.deps.voice.pitch,
      onFirstByte: (ms: number) => {
        firstByte = ms
      }
    }
    const done = (outcome: 'ok' | 'skip' | 'fallback', attempts: number, bytes?: number): void => {
      const ms = Math.round(performance.now() - t0)
      if (kind === 'speech' && this.firstSynthMs === undefined && outcome !== 'skip') {
        this.firstSynthMs = ms
        this.firstByteMs = firstByte === undefined ? undefined : Math.round(firstByte)
      }
      this.deps.trace?.('tts.sentence', {
        seq,
        kind,
        chars: text.length,
        ms,
        firstByteMs: firstByte === undefined ? undefined : Math.round(firstByte),
        attempts,
        outcome,
        bytes,
        engine: outcome === 'fallback' ? this.deps.fallback.name : this.deps.engine.name
      })
    }
    if (this.degraded) {
      const out = await this.deps.fallback.synth(req, this.signal)
      done('fallback', 0)
      return out
    }
    const attempts = this.deps.attempts ?? DEFAULT_TUNING.speech.ttsAttempts
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const buf = await this.deps.engine.synth(req, this.signal)
        this.consecutiveFailures = 0
        done('ok', attempt + 1, buf?.length)
        return buf
      } catch (e) {
        if (isAbort(e) || this.signal.aborted) throw e
        this.deps.log(`tts attempt ${attempt + 1} failed: ${(e as Error).message}`)
      }
    }
    this.consecutiveFailures++
    if (this.consecutiveFailures >= (this.deps.degradeAfter ?? DEFAULT_TUNING.speech.ttsDegradeAfter)) {
      if (!this.degraded) {
        this.degraded = true
        this.deps.onDegraded()
      }
      const out = await this.deps.fallback.synth(req, this.signal)
      done('fallback', attempts)
      return out
    }
    done('skip', attempts)
    return 'skip'
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length) {
        const item = this.queue[0]!
        let result: Buffer | null | 'skip'
        try {
          result = await item.result
        } catch {
          if (this.signal.aborted) return
          result = 'skip'
        }
        if (this.signal.aborted) return
        this.queue.shift()
        if (result === 'skip') continue
        const last = this.finished && this.queue.length === 0
        this.emit(item.seq, item.text, item.kind, result, last)
      }
      if (this.finished && !this.emittedLast && !this.signal.aborted) {
        this.emit(this.seq++, '', 'speech', null, true)
      }
    } finally {
      this.pumping = false
      if (this.finished && this.queue.length === 0) this.resolveDone()
      else if (this.signal.aborted) this.resolveDone()
    }
  }

  private emit(seq: number, text: string, kind: Kind, mp3: Buffer | null, last: boolean): void {
    if (last) this.emittedLast = true
    if (text) {
      const now = performance.now()
      const start = Math.max(now, this.busyUntil)
      this.busyUntil = start + (text.length / CHARS_PER_SECOND) * 1000
    }
    const bytes = mp3 ? mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength) : new ArrayBuffer(0)
    this.deps.emit({ turnId: this.turnId, seq, text, kind, mp3: bytes as ArrayBuffer, last })
  }
}
