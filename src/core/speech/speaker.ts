import type { AudioChunk, VoiceSettings } from '@shared/types'
import { isAbort, type TtsEngine } from './tts'

export interface SpeakerDeps {
  silent?: boolean
  engine: TtsEngine
  fallback: TtsEngine
  voice: VoiceSettings
  emit(chunk: AudioChunk): void
  onDegraded(): void
  log(msg: string): void
}

type Item = { seq: number; text: string; result: Promise<Buffer | null | 'skip'> }

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
  private resolveDone!: () => void
  readonly done = new Promise<void>((r) => (this.resolveDone = r))

  constructor(
    readonly turnId: string,
    private readonly deps: SpeakerDeps,
    private readonly signal: AbortSignal
  ) {}

  say(text: string): void {
    const clean = text.trim()
    if (!clean || this.finished || this.signal.aborted || this.deps.silent) return
    const seq = this.seq++
    const result = this.synth(clean)
    result.catch(() => undefined)
    this.queue.push({ seq, text: clean, result })
    void this.pump()
  }

  finish(): Promise<void> {
    this.finished = true
    void this.pump()
    return this.done
  }

  private async synth(text: string): Promise<Buffer | null | 'skip'> {
    const req = { text, voice: this.deps.voice.voice, rate: this.deps.voice.rate, pitch: this.deps.voice.pitch }
    if (this.degraded) return this.deps.fallback.synth(req, this.signal)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const buf = await this.deps.engine.synth(req, this.signal)
        this.consecutiveFailures = 0
        return buf
      } catch (e) {
        if (isAbort(e) || this.signal.aborted) throw e
        this.deps.log(`tts attempt ${attempt + 1} failed: ${(e as Error).message}`)
      }
    }
    this.consecutiveFailures++
    if (this.consecutiveFailures >= 3) {
      if (!this.degraded) {
        this.degraded = true
        this.deps.onDegraded()
      }
      return this.deps.fallback.synth(req, this.signal)
    }
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
        this.emit(item.seq, item.text, result, last)
      }
      if (this.finished && !this.emittedLast && !this.signal.aborted) {
        this.emit(this.seq++, '', null, true)
      }
    } finally {
      this.pumping = false
      if (this.finished && this.queue.length === 0) this.resolveDone()
      else if (this.signal.aborted) this.resolveDone()
    }
  }

  private emit(seq: number, text: string, mp3: Buffer | null, last: boolean): void {
    if (last) this.emittedLast = true
    const bytes = mp3 ? mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength) : new ArrayBuffer(0)
    this.deps.emit({ turnId: this.turnId, seq, text, mp3: bytes as ArrayBuffer, last })
  }
}
