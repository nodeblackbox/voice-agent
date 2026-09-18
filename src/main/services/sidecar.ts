import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { ServiceStatus, SttSettings } from '@shared/types'
import { DEFAULT_TUNING } from '@shared/tuning'
import type { Trace } from '@core/trace'
import { log, logAt, sidecarLevel } from './log'

export interface TurnCheck {
  silenceMs: number
  p: number
  heldOnFiller: boolean
  lastWord: string
}

export type SidecarEvent =
  | { type: 'status'; stage: string; detail?: string }
  | { type: 'ready'; asrModel: string; device: string; providers: string[]; loadS: number }
  | { type: 'level'; p: number }
  | { type: 'speech_start'; t: number }
  | { type: 'partial'; text: string }
  | { type: 'speech_end'; reason: 'done' | 'timeout'; silenceMs: number; turnP: number | null; speechMs?: number; checks?: TurnCheck[]; afterCut?: boolean }
  | { type: 'final'; text: string; durationMs: number; asrMs: number; asrRtf?: number | null; turnP: number | null; reason: string; queuedMs?: number; afterCut?: boolean }
  | { type: 'bargein'; stage: 'duck' | 'cut' | 'release'; prerollMs?: number }
  | { type: 'stats'; turns?: number; turnChecks?: number; turnCostP50Ms?: number | null; heldOnFiller?: number; backchannels?: number; cuts?: number; cutsEmptyFinal?: number }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'pong' }

export interface SidecarOptions {
  projectRoot: string
  stt: () => SttSettings
  /** Every ear-scoped tuning value, flattened (see `earConfig` in shared/tuning). */
  earConfig: () => Record<string, unknown>
  /** 0 = keep the models loaded while the mic is off. */
  idleShutdownMs?: () => number
  trace?: Trace
  onEvent(event: SidecarEvent): void
  onStatus(status: ServiceStatus): void
  /** Test seams. */
  spawn?: typeof spawn
  WebSocketImpl?: typeof WebSocket
}

const BACKOFF_MS = [1000, 3000, 10000]
const WS_RECONNECT_MS = [500, 1000, 2000, 4000]
const HEARTBEAT_MS = 10_000
const MISSED_PONGS_BEFORE_RESTART = 2
/** A reconnected socket must stay up this long before the drop counter is forgiven. */
const WS_STABLE_MS = 30_000
/** Frames kept while the ears are loading so the first utterance after a cold start is not lost. */
const PENDING_FRAMES_MAX = Math.ceil(10_000 / 32)

export class SidecarService {
  private proc: ChildProcess | null = null
  private ws: WebSocket | null = null
  private port: number | null = null
  private stopping = false
  private failures = 0
  private wsRetries = 0
  private listening = false
  private speaking = false
  private thinking = false
  private modelsReady = false
  private restartTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private awaitingPongs = 0
  private pending: Buffer[] = []
  private pendingDropped = 0
  private frames = 0
  status: ServiceStatus = { name: 'sidecar', state: 'off' }

  constructor(private readonly opts: SidecarOptions) {}

  private get idleShutdownMs(): number {
    return this.opts.idleShutdownMs?.() ?? DEFAULT_TUNING.runtime.idleShutdownMs
  }

  private setStatus(state: ServiceStatus['state'], detail?: string): void {
    this.status = { name: 'sidecar', state, detail }
    this.opts.onStatus(this.status)
  }

  private trace(ev: string, data: Record<string, unknown> = {}): void {
    this.opts.trace?.({ ev: `sidecar.${ev}`, ...data })
  }

  resolvePython(): string {
    const candidates = [this.opts.stt().pythonPath.trim(), process.env.VA_PYTHON?.trim() ?? '', join(this.opts.projectRoot, 'sidecar', '.venv', 'Scripts', 'python.exe')].filter(Boolean)
    for (const c of candidates) if (existsSync(c)) return c
    return 'python'
  }

  start(): void {
    if (this.proc || this.stopping) return
    const python = this.resolvePython()
    const stt = this.opts.stt()
    const args = ['-m', 'ear', '--port', '0', '--models-dir', join(this.opts.projectRoot, 'models'), '--stt-model', stt.model, '--stt-device', stt.device]
    log('sidecar', `spawning ${python} ${args.join(' ')}`)
    this.trace('spawn', { python, model: stt.model, device: stt.device })
    this.setStatus('starting', python === 'python' ? 'starting python (set the Python path in Settings if this fails; see sidecar/install.ps1)' : 'starting python')
    let proc: ChildProcess
    try {
      proc = (this.opts.spawn ?? spawn)(python, args, { cwd: join(this.opts.projectRoot, 'sidecar'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      this.setStatus('error', `could not start python (${(e as Error).message}). Set the Python path in Settings or run sidecar/install.ps1.`)
      return
    }
    this.proc = proc
    this.modelsReady = false
    this.wsRetries = 0
    let stdoutBuf = ''
    proc.stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString()
      const m = /EAR_PORT (\d+)/.exec(stdoutBuf)
      if (m && !this.ws) {
        stdoutBuf = ''
        this.port = Number(m[1])
        this.connect(this.port)
      }
    })
    proc.stderr?.on('data', (d: Buffer) => {
      // onnxruntime writes its warnings as UTF-16 on Windows; everything else is UTF-8
      const wide = d.length > 4 && d[1] === 0 && d[3] === 0
      const text = wide ? d.toString('utf16le') : d.toString()
      for (const raw of text.split(/\r?\n/)) {
        // strip ANSI colour codes before parsing the python log level
        // eslint-disable-next-line no-control-regex
        const line = raw.trim().replace(/\[[0-9;]*m/g, '')
        if (!line) continue
        const { level, msg } = sidecarLevel(line)
        logAt(level, 'ear', msg)
      }
    })
    proc.on('error', (e) => {
      log('sidecar', `spawn error: ${e.message}`)
      this.setStatus('error', `could not start python (${e.message}). Set the Python path in Settings or run sidecar/install.ps1.`)
    })
    proc.on('exit', (code, signal) => {
      log('sidecar', `exited code=${code} signal=${signal}`)
      this.trace('exit', { code, signal, stopping: this.stopping })
      this.proc = null
      this.modelsReady = false
      this.closeSocket()
      if (this.stopping) {
        this.setStatus('off')
        return
      }
      if (code === 3) {
        this.setStatus('error', 'CUDA is not available for the ears. Switch STT device to CPU in Settings.')
        return
      }
      const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!
      this.failures++
      if (this.failures > BACKOFF_MS.length) {
        this.setStatus('error', `ears crashed ${this.failures} times; use "Restart ears" in Settings`)
        return
      }
      this.setStatus('reconnecting', `ears crashed, restarting in ${delay / 1000}s`)
      this.trace('restart', { delayMs: delay, failures: this.failures })
      this.restartTimer = setTimeout(() => this.start(), delay)
    })
  }

  private connect(port: number): void {
    const Impl = this.opts.WebSocketImpl ?? WebSocket
    const ws = new Impl(`ws://127.0.0.1:${port}/`)
    this.ws = ws
    ws.on('open', () => {
      log('sidecar', `connected on ${port}`)
      this.trace('connected', { port, retries: this.wsRetries })
      if (this.stableTimer) clearTimeout(this.stableTimer)
      this.stableTimer = setTimeout(() => {
        this.wsRetries = 0
      }, WS_STABLE_MS)
      this.stableTimer.unref?.()
      this.applyConfig()
      this.send({ type: 'mute', on: !this.listening })
      this.send({ type: 'agent_speaking', on: this.speaking })
      this.send({ type: 'agent_thinking', on: this.thinking })
      this.startHeartbeat()
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      let evt: SidecarEvent
      try {
        evt = JSON.parse(data.toString()) as SidecarEvent
      } catch {
        return
      }
      if (evt.type === 'pong') {
        this.awaitingPongs = 0
        return
      }
      if (evt.type === 'status') this.setStatus('starting', evt.detail ?? evt.stage.replace('_', ' '))
      else if (evt.type === 'ready') {
        this.failures = 0
        this.modelsReady = true
        this.setStatus('ready', `${evt.asrModel} on ${evt.device} (${evt.loadS.toFixed(1)}s)`)
        this.flushPending()
      } else if (evt.type === 'error' && evt.fatal) this.setStatus('error', evt.message)
      this.opts.onEvent(evt)
    })
    ws.on('error', (e) => logAt('warn', 'sidecar', `ws error: ${e.message}`))
    ws.on('close', (code) => {
      const alive = this.proc !== null
      this.trace('ws_close', { code, processAlive: alive })
      if (this.ws === ws) this.ws = null
      this.stopHeartbeat()
      if (this.stableTimer) clearTimeout(this.stableTimer)
      this.stableTimer = null
      if (!alive || this.stopping || this.port === null) return
      // the process is up but the socket dropped: reconnect, and give up on the process if it keeps happening
      if (this.wsRetries >= WS_RECONNECT_MS.length) {
        logAt('warn', 'sidecar', 'websocket keeps closing; restarting the ears')
        this.restart()
        return
      }
      const delay = WS_RECONNECT_MS[this.wsRetries++]!
      this.setStatus('reconnecting', `ears connection dropped, reconnecting in ${delay} ms`)
      this.reconnectTimer = setTimeout(() => {
        if (this.proc && !this.ws && this.port !== null) this.connect(this.port)
      }, delay)
    })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.awaitingPongs = 0
    this.heartbeat = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      if (this.awaitingPongs >= MISSED_PONGS_BEFORE_RESTART) {
        logAt('warn', 'sidecar', `no pong for ${this.awaitingPongs} heartbeats; restarting the ears`)
        this.trace('heartbeat_lost', { missed: this.awaitingPongs })
        this.restart()
        return
      }
      this.awaitingPongs++
      this.send({ type: 'ping' })
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private closeSocket(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
    const ws = this.ws
    this.ws = null
    ws?.terminate()
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  applyConfig(): void {
    this.send({ type: 'config', endpoint: this.opts.earConfig(), stt: this.opts.stt() })
  }

  /** Frames arriving before the models are ready are held (bounded) and replayed on `ready`. */
  sendFrame(pcm: ArrayBuffer): void {
    if (!this.listening) return
    if (!this.modelsReady || this.ws?.readyState !== WebSocket.OPEN) {
      if (this.pending.length >= PENDING_FRAMES_MAX) {
        this.pending.shift()
        this.pendingDropped++
      }
      this.pending.push(Buffer.from(pcm))
      return
    }
    if (this.frames++ === 0) log('sidecar', `mic frames flowing (${pcm.byteLength} bytes/frame)`)
    this.ws.send(Buffer.from(pcm), { binary: true })
  }

  private flushPending(): void {
    if (!this.pending.length || this.ws?.readyState !== WebSocket.OPEN) {
      this.pending = []
      this.pendingDropped = 0
      return
    }
    const frames = this.pending
    const dropped = this.pendingDropped
    this.pending = []
    this.pendingDropped = 0
    if (!this.listening) return
    for (const f of frames) this.ws.send(f, { binary: true })
    this.frames += frames.length
    log('sidecar', `replayed ${frames.length} buffered frames (${Math.round((frames.length * 32) / 100) / 10}s) captured while the ears were loading`)
    this.trace('buffer_flushed', { frames: frames.length, ms: frames.length * 32, dropped })
  }

  get bufferedFrames(): number {
    return this.pending.length
  }

  setListening(on: boolean): void {
    if (on) this.frames = 0
    else if (this.listening) log('sidecar', `listening off after ${this.frames} frames`)
    this.listening = on
    if (!on) {
      this.pending = []
      this.pendingDropped = 0
    }
    this.send({ type: 'mute', on: !on })
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (on) {
      if (!this.proc) this.start()
      else if (!this.modelsReady) this.setStatus('starting', this.status.detail ?? 'loading the ears')
      return
    }
    // the models hold several GB; give them back if the microphone stays closed
    const idleMs = this.idleShutdownMs
    if (this.proc && idleMs > 0) {
      this.idleTimer = setTimeout(() => {
        if (this.listening) return
        log('sidecar', `idle for ${Math.round(idleMs / 60000)} min, releasing the models`)
        this.trace('idle_shutdown', { idleMs })
        this.shutdownIdle()
      }, idleMs)
    }
  }

  private shutdownIdle(): void {
    const p = this.proc
    if (!p) return
    this.proc = null
    this.modelsReady = false
    p.removeAllListeners('exit')
    this.closeSocket()
    p.kill()
    this.setStatus('off', 'idle; starts again when you press Voice')
  }

  agentSpeaking(on: boolean): void {
    if (this.speaking === on) return
    this.speaking = on
    this.send({ type: 'agent_speaking', on })
  }

  agentThinking(on: boolean): void {
    if (this.thinking === on) return
    this.thinking = on
    this.send({ type: 'agent_thinking', on })
  }

  get ready(): boolean {
    return this.status.state === 'ready' && this.ws?.readyState === WebSocket.OPEN
  }

  restart(): void {
    this.failures = 0
    this.wsRetries = 0
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.proc) {
      const p = this.proc
      p.removeAllListeners('exit')
      p.once('exit', () => {
        this.proc = null
        this.modelsReady = false
        this.start()
      })
      this.closeSocket()
      p.kill()
      return
    }
    this.start()
  }

  stop(): void {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.closeSocket()
    this.proc?.kill()
    this.proc = null
    this.modelsReady = false
    this.setStatus('off')
  }
}
