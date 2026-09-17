import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

export interface TtsRequest {
  text: string
  voice: string
  rate: number
  pitch: number
}

// Returns MP3 bytes, or null when the renderer should speak the text itself (system voice).
export interface TtsEngine {
  readonly name: 'edge' | 'system'
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
    private readonly max = 3,
    private readonly timeoutMs = 12_000
  ) {}

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

  async synth(req: TtsRequest, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) throw abortError()
    const w = await this.acquire()
    let healthy = true
    try {
      await w.ensure(req.voice)
      return await new Promise<Buffer>((resolve, reject) => {
        let settled = false
        const chunks: Buffer[] = []
        const { audioStream } = w.tts.toStream(escapeXml(req.text), {
          rate: req.rate,
          pitch: `${req.pitch >= 0 ? '+' : ''}${Math.round(req.pitch)}Hz`
        })
        const finish = (err: Error | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          if (err) {
            healthy = false
            audioStream.destroy()
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
        const timer = setTimeout(() => finish(new Error('Edge TTS timed out')), this.timeoutMs)
        signal.addEventListener('abort', onAbort, { once: true })
        audioStream.on('data', (d: Buffer) => chunks.push(d))
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
