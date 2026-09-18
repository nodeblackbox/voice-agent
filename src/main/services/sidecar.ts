import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { EndpointSettings, ServiceStatus, SttSettings } from '@shared/types'
import { log } from './log'

export type SidecarEvent =
  | { type: 'status'; stage: string; detail?: string }
  | { type: 'ready'; asrModel: string; device: string; providers: string[]; loadS: number }
  | { type: 'level'; p: number }
  | { type: 'speech_start'; t: number }
  | { type: 'partial'; text: string }
  | { type: 'speech_end'; reason: 'done' | 'timeout'; silenceMs: number; turnP: number | null }
  | { type: 'final'; text: string; durationMs: number; asrMs: number; turnP: number | null; reason: string }
  | { type: 'bargein'; stage: 'duck' | 'cut' | 'release' }
  | { type: 'stats'; asrRtf?: number; turnCostMs?: number; gpuMiB?: number }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'pong' }

export interface SidecarOptions {
  projectRoot: string
  stt: () => SttSettings
  endpoint: () => EndpointSettings
  onEvent(event: SidecarEvent): void
  onStatus(status: ServiceStatus): void
}

const BACKOFF_MS = [1000, 3000, 10000]

export class SidecarService {
  private proc: ChildProcess | null = null
  private ws: WebSocket | null = null
  private stopping = false
  private failures = 0
  private listening = false
  private speaking = false
  private thinking = false
  private restartTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  status: ServiceStatus = { name: 'sidecar', state: 'off' }

  constructor(
    private readonly opts: SidecarOptions,
    private readonly idleShutdownMs = 5 * 60_000
  ) {}

  private setStatus(state: ServiceStatus['state'], detail?: string): void {
    this.status = { name: 'sidecar', state, detail }
    this.opts.onStatus(this.status)
  }

  resolvePython(): string {
    const configured = this.opts.stt().pythonPath.trim()
    const candidates = [
      configured,
      join(this.opts.projectRoot, 'sidecar', '.venv', 'Scripts', 'python.exe'),
      'D:\\Downloads\\voiceAgent\\.venv\\Scripts\\python.exe'
    ].filter(Boolean)
    for (const c of candidates) if (existsSync(c)) return c
    return 'python'
  }

  start(): void {
    if (this.proc || this.stopping) return
    const python = this.resolvePython()
    const stt = this.opts.stt()
    const args = ['-m', 'ear', '--port', '0', '--models-dir', join(this.opts.projectRoot, 'models'), '--stt-model', stt.model, '--stt-device', stt.device]
    log('sidecar', `spawning ${python} ${args.join(' ')}`)
    this.setStatus('starting', 'starting python')
    let proc: ChildProcess
    try {
      proc = spawn(python, args, { cwd: join(this.opts.projectRoot, 'sidecar'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      this.setStatus('error', `could not start python: ${(e as Error).message}`)
      return
    }
    this.proc = proc
    let stdoutBuf = ''
    proc.stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString()
      const m = /EAR_PORT (\d+)/.exec(stdoutBuf)
      if (m && !this.ws) {
        stdoutBuf = ''
        this.connect(Number(m[1]))
      }
    })
    proc.stderr?.on('data', (d: Buffer) => {
      // onnxruntime writes its warnings as UTF-16 on Windows; everything else is UTF-8
      const wide = d.length > 4 && d[1] === 0 && d[3] === 0
      const text = wide ? d.toString('utf16le') : d.toString()
      for (const line of text.split(/\r?\n/)) if (line.trim()) log('ear', line.trim().replace(/\[[0-9;]*m/g, ''))
    })
    proc.on('exit', (code, signal) => {
      log('sidecar', `exited code=${code} signal=${signal}`)
      this.proc = null
      this.ws?.terminate()
      this.ws = null
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
      this.restartTimer = setTimeout(() => this.start(), delay)
    })
  }

  private connect(port: number): void {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    this.ws = ws
    ws.on('open', () => {
      log('sidecar', `connected on ${port}`)
      this.applyConfig()
      this.send({ type: 'mute', on: !this.listening })
      this.send({ type: 'agent_speaking', on: this.speaking })
      this.send({ type: 'agent_thinking', on: this.thinking })
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      let evt: SidecarEvent
      try {
        evt = JSON.parse(data.toString()) as SidecarEvent
      } catch {
        return
      }
      if (evt.type === 'status') this.setStatus('starting', evt.detail ?? evt.stage.replace('_', ' '))
      else if (evt.type === 'ready') {
        this.failures = 0
        this.setStatus('ready', `${evt.asrModel} on ${evt.device} (${evt.loadS.toFixed(1)}s)`)
      } else if (evt.type === 'error' && evt.fatal) this.setStatus('error', evt.message)
      this.opts.onEvent(evt)
    })
    ws.on('error', (e) => log('sidecar', `ws error: ${e.message}`))
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null
    })
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  applyConfig(): void {
    this.send({ type: 'config', endpoint: this.opts.endpoint(), stt: this.opts.stt() })
  }

  private frames = 0

  sendFrame(pcm: ArrayBuffer): void {
    if (!this.listening || this.ws?.readyState !== WebSocket.OPEN) return
    if (this.frames++ === 0) log('sidecar', `mic frames flowing (${pcm.byteLength} bytes/frame)`)
    this.ws.send(Buffer.from(pcm), { binary: true })
  }

  setListening(on: boolean): void {
    if (on) this.frames = 0
    else if (this.listening) log('sidecar', `listening off after ${this.frames} frames`)
    this.listening = on
    this.send({ type: 'mute', on: !on })
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (on) {
      if (!this.proc) this.start()
      return
    }
    // the models hold several GB; give them back if the microphone stays closed
    if (this.proc && this.idleShutdownMs > 0) {
      this.idleTimer = setTimeout(() => {
        if (this.listening) return
        log('sidecar', `idle for ${Math.round(this.idleShutdownMs / 60000)} min, releasing the models`)
        this.shutdownIdle()
      }, this.idleShutdownMs)
    }
  }

  private shutdownIdle(): void {
    const p = this.proc
    if (!p) return
    this.proc = null
    p.removeAllListeners('exit')
    this.ws?.terminate()
    this.ws = null
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
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.proc) {
      const p = this.proc
      p.removeAllListeners('exit')
      p.once('exit', () => {
        this.proc = null
        this.ws = null
        this.start()
      })
      p.kill()
      this.ws?.terminate()
      return
    }
    this.start()
  }

  stop(): void {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.ws?.terminate()
    this.ws = null
    this.proc?.kill()
    this.proc = null
    this.setStatus('off')
  }
}
