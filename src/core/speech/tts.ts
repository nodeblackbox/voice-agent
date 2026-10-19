import type { Readable } from 'node:stream'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { DEFAULT_TUNING } from '@shared/tuning'

/** Frames msedge-tts delivered for a request whose stream was already destroyed (abort/timeout) or not yet registered. */
export const edgeTtsStats = { droppedFrames: 0 }

type StreamOwner = { _streams?: Record<string, Record<string, unknown> | undefined> }
type Push = (this: StreamOwner, data: unknown, requestId: string) => void

// msedge-tts shares one socket per client; with pooled workers a frame can arrive for a request
// whose stream we destroyed on abort/timeout, and the library then throws inside its socket
// handler and takes the process down. Guard the push and count what was dropped instead.
export function guardStreamPush(original: Push, field: 'audio' | 'metadata'): Push {
  return function (this: StreamOwner, data: unknown, requestId: string): void {
    const stream = this._streams?.[requestId]
    if (stream && stream[field]) original.call(this, data, requestId)
    else edgeTtsStats.droppedFrames++
  }
}

const proto = MsEdgeTTS.prototype as unknown as Record<string, Push | undefined>
if (proto._pushAudioData) proto._pushAudioData = guardStreamPush(proto._pushAudioData, 'audio')
if (proto._pushMetadata) proto._pushMetadata = guardStreamPush(proto._pushMetadata, 'metadata')

export interface TtsRequest {
  text: string
  voice: string
  rate: number
  pitch: number
  /** Called once with request -> first audio byte latency, when the engine can measure it. */
  onFirstByte?: (ms: number) => void
}

// Returns MP3 bytes, or null when the renderer should speak the text itself (system voice).
export interface TtsEngine {
  readonly name: 'edge' | 'system' | 'kokoro'
  synth(req: TtsRequest, signal: AbortSignal): Promise<Buffer | null>
}

export class SystemTtsEngine implements TtsEngine {
  readonly name = 'system'
  async synth(): Promise<null> {
    return null
  }
}

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })
export const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError'

/** The local Kokoro process, owned by the main process. */
export interface KokoroBackend {
  ready(): boolean
  start(): Promise<boolean>
  synth(text: string, voice: string, speed: number, signal: AbortSignal): Promise<Buffer>
}

// `voice.rate` is Edge's prosody value: around 1 it is a multiplier, the Settings slider stores a
// relative offset (-0.5..0.5). Map both onto Kokoro's speed multiplier.
export const kokoroSpeed = (rate: number): number => Math.min(2, Math.max(0.5, rate >= 0.5 ? rate : 1 + rate))

// Last-resort local voice. Never throws for engine trouble: while Kokoro is loading or broken it
// returns null, which the renderer speaks with the Windows voice.
export class KokoroTtsEngine implements TtsEngine {
  readonly name = 'kokoro'

  constructor(
    private readonly backend: KokoroBackend,
    private readonly voice: () => string,
    private readonly log: (msg: string) => void = () => undefined
  ) {}

  async synth(req: TtsRequest, signal: AbortSignal): Promise<Buffer | null> {
    if (signal.aborted) throw abortError()
    if (!this.backend.ready()) {
      void this.backend.start()
      return null
    }
    const t0 = performance.now()
    try {
      const buf = await this.backend.synth(req.text, this.voice(), kokoroSpeed(req.rate), signal)
      req.onFirstByte?.(performance.now() - t0)
      return buf
    } catch (e) {
      if (signal.aborted) throw abortError()
      this.log(`kokoro synth failed: ${(e as Error).message}`)
      return null
    }
  }
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

class Worker {
  tts = new MsEdgeTTS()
  voice = ''

  async ensure(voice: string): Promise<void> {
    if (this.voice === voice) return
    await this.tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    this.voice = voice
  }

  /** Reopen the socket if Edge closed it while idle; setMetadata is a no-op when it is still open. */
  async warm(voice: string): Promise<void> {
    await this.tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    this.voice = voice
  }

  dispose(): void {
    try {
      this.tts.close()
    } catch {
      // already closed
    }
  }
}

// A small pool of Edge websocket clients so several sentences can synthesize concurrently
// while the model is still streaming, without opening a socket per sentence.
export class EdgeTtsEngine implements TtsEngine {
  readonly name = 'edge'
  private idle: Worker[] = []
  private count = 0
  private waiters: Array<(w: Worker) => void> = []

  constructor(
    private readonly max: number = DEFAULT_TUNING.speech.ttsPoolSize,
    private readonly timeoutMs: number | (() => number) = DEFAULT_TUNING.speech.ttsTimeoutMs
  ) {}

  private get timeout(): number {
    return typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs
  }

  private acquire(): Promise<Worker> {
    const w = this.idle.pop()
    if (w) return Promise.resolve(w)
    if (this.count < this.max) {
      this.count++
      return Promise.resolve(new Worker())
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private release(w: Worker, healthy: boolean): void {
    if (!healthy) {
      w.dispose()
      w = new Worker()
    }
    const waiter = this.waiters.shift()
    if (waiter) waiter(w)
    else this.idle.push(w)
  }

  /**
   * Pre-open one socket for `voice` so the first sentence of the coming reply skips the handshake.
   * Runs while the model is still thinking; never throws and never waits for a busy pool.
   */
  async warm(voice: string): Promise<boolean> {
    if (this.idle.length === 0 && this.count >= this.max) return false
    const w = await this.acquire()
    let healthy = true
    try {
      await w.warm(voice)
      return true
    } catch {
      healthy = false
      return false
    } finally {
      this.release(w, healthy)
    }
  }

  async synth(req: TtsRequest, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) throw abortError()
    const w = await this.acquire()
    let healthy = true
    try {
      await w.ensure(req.voice)
      const t0 = performance.now()
      return await new Promise<Buffer>((resolve, reject) => {
        let settled = false
        const chunks: Buffer[] = []
        let audioStream: Readable | null = null

        try {
          const result = w.tts.toStream(escapeXml(req.text), {
            rate: req.rate,
            pitch: `${req.pitch >= 0 ? '+' : ''}${Math.round(req.pitch)}Hz`
          })
          audioStream = result.audioStream
        } catch (e) {
          // Handle race condition or initialization errors in msedge-tts
          healthy = false
          reject(e instanceof Error ? e : new Error(String(e)))
          return
        }

        const finish = (err: Error | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          if (err) {
            healthy = false
            audioStream?.destroy()
            reject(err)
            return
          }
          const buf = Buffer.concat(chunks)
          if (!buf.length) {
            healthy = false
            reject(new Error('Edge TTS returned no audio'))
          } else resolve(buf)
        }
        const onAbort = (): void => finish(abortError())
        const timer = setTimeout(() => finish(new Error('Edge TTS timed out')), this.timeout)
        signal.addEventListener('abort', onAbort, { once: true })
        audioStream.on('data', (d: Buffer) => {
          if (!chunks.length) req.onFirstByte?.(performance.now() - t0)
          chunks.push(d)
        })
        audioStream.on('error', (e: Error) => finish(e))
        audioStream.on('end', () => finish(null))
        audioStream.on('close', () => finish(null))
      })
    } catch (e) {
      healthy = false
      throw e
    } finally {
      this.release(w, healthy)
    }
  }

  async listVoices(): Promise<Array<{ name: string; shortName: string; locale: string; gender: string }>> {
    const w = await this.acquire()
    try {
      const voices = await w.tts.getVoices()
      return voices.map((v) => ({ name: v.FriendlyName, shortName: v.ShortName, locale: v.Locale, gender: v.Gender }))
    } finally {
      this.release(w, true)
    }
  }
}
