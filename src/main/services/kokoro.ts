import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { KokoroBackend } from '@core/speech/tts'
import { log, logAt } from './log'

export interface KokoroOptions {
  projectRoot: string
  python: () => string
  voice: () => string
  /** Test seam. */
  spawn?: typeof spawn
}

const LOAD_TIMEOUT_MS = 120_000
/** After a failed load, don't try again for this long (a broken venv shouldn't respawn every sentence). */
const RETRY_AFTER_MS = 5 * 60_000

// Kokoro-82M in a Python child (`sidecar/mouth`), started on demand when Edge TTS is unreachable.
export class KokoroService implements KokoroBackend {
  private proc: ChildProcess | null = null
  private port: number | null = null
  private starting: Promise<boolean> | null = null
  private failedAt = 0

  constructor(private readonly opts: KokoroOptions) {}

  ready(): boolean {
    return this.port !== null
  }

  start(): Promise<boolean> {
    if (this.port !== null) return Promise.resolve(true)
    if (this.starting) return this.starting
    if (Date.now() - this.failedAt < RETRY_AFTER_MS) return Promise.resolve(false)
    this.starting = this.launch().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private launch(): Promise<boolean> {
    const python = this.opts.python()
    const args = ['-m', 'mouth', '--port', '0', '--voice', this.opts.voice()]
    log('kokoro', `spawning ${python} ${args.join(' ')}`)
    return new Promise((resolve) => {
      let settled = false
      const done = (ok: boolean, why?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!ok) {
          this.failedAt = Date.now()
          logAt('warn', 'kokoro', `not available: ${why}`)
          this.stop()
        }
        resolve(ok)
      }
      const timer = setTimeout(() => done(false, `did not load within ${LOAD_TIMEOUT_MS / 1000}s`), LOAD_TIMEOUT_MS)
      let proc: ChildProcess
      try {
        proc = (this.opts.spawn ?? spawn)(python, args, {
          cwd: join(this.opts.projectRoot, 'sidecar'),
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (e) {
        done(false, (e as Error).message)
        return
      }
      this.proc = proc
      let out = ''
      proc.stdout?.on('data', (d: Buffer) => {
        out += d.toString()
        const m = /MOUTH_PORT (\d+)/.exec(out)
        if (m && this.port === null) {
          this.port = Number(m[1])
          log('kokoro', `ready on ${this.port}`)
          done(true)
        }
      })
      proc.stderr?.on('data', (d: Buffer) => {
        for (const line of d.toString().split(/\r?\n/)) if (line.trim() && !/warn/i.test(line)) log('kokoro', line.trim())
      })
      proc.on('error', (e) => done(false, e.message))
      proc.on('exit', (code) => {
        log('kokoro', `exited code=${code}`)
        if (this.proc === proc) {
          this.proc = null
          this.port = null
        }
        done(false, `exited with code ${code} while loading`)
      })
    })
  }

  async synth(text: string, voice: string, speed: number, signal: AbortSignal): Promise<Buffer> {
    if (this.port === null) throw new Error('Kokoro is not running')
    const res = await fetch(`http://127.0.0.1:${this.port}/synth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice, speed }),
      signal
    })
    if (!res.ok) throw new Error(`Kokoro ${res.status}: ${await res.text()}`)
    return Buffer.from(await res.arrayBuffer())
  }

  stop(): void {
    // closing stdin is the child's cue to exit; kill covers a wedged process
    this.proc?.stdin?.end()
    this.proc?.kill()
    this.proc = null
    this.port = null
  }
}
