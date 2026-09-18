import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { SidecarService, type SidecarEvent } from './sidecar'

// --- fakes ---------------------------------------------------------------------------------
class FakeProc extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill(): boolean {
    this.killed = true
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 0)
    return true
  }
}

class FakeWs extends EventEmitter {
  static instances: FakeWs[] = []
  readyState: number = WebSocket.CONNECTING
  sent: Array<{ binary: boolean; data: Buffer | string }> = []
  constructor(readonly url: string) {
    super()
    FakeWs.instances.push(this)
  }
  open(): void {
    this.readyState = WebSocket.OPEN
    this.emit('open')
  }
  send(data: Buffer | string, opts?: { binary?: boolean }): void {
    this.sent.push({ binary: !!opts?.binary, data })
  }
  receive(evt: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(evt)), false)
  }
  terminate(): void {
    this.readyState = WebSocket.CLOSED
  }
  get text(): Array<Record<string, unknown>> {
    return this.sent.filter((s) => !s.binary).map((s) => JSON.parse(String(s.data)) as Record<string, unknown>)
  }
  get frames(): number {
    return this.sent.filter((s) => s.binary).length
  }
}

function harness() {
  const procs: FakeProc[] = []
  const events: SidecarEvent[] = []
  const statuses: string[] = []
  const traces: Array<Record<string, unknown>> = []
  FakeWs.instances = []
  const svc = new SidecarService({
    projectRoot: 'D:/fake',
    stt: () => ({ model: 'm', device: 'cpu', pythonPath: '' }),
    earConfig: () => ({ vadThreshold: 0.5 }),
    idleShutdownMs: () => 0,
    trace: (e) => traces.push(e),
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(`${s.state}:${s.detail ?? ''}`),
    spawn: (() => {
      const p = new FakeProc()
      procs.push(p)
      return p
    }) as unknown as typeof import('node:child_process').spawn,
    WebSocketImpl: FakeWs as unknown as typeof WebSocket
  })
  return { svc, procs, events, statuses, traces, ws: () => FakeWs.instances.at(-1)! }
}

const frame = (): ArrayBuffer => new Uint8Array(1024).buffer

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SidecarService', () => {
  it('buffers mic frames while the models load and replays them on ready', async () => {
    const h = harness()
    h.svc.setListening(true)
    expect(h.procs).toHaveLength(1)
    // frames before the port is even known
    h.svc.sendFrame(frame())
    h.svc.sendFrame(frame())
    h.procs[0]!.stdout.write('EAR_PORT 4321\n')
    await vi.advanceTimersByTimeAsync(0)
    const ws = h.ws()
    expect(ws.url).toBe('ws://127.0.0.1:4321/')
    ws.open()
    // connected but models still loading: keep buffering
    ws.receive({ type: 'status', stage: 'loading_asr' })
    h.svc.sendFrame(frame())
    expect(ws.frames).toBe(0)
    expect(h.svc.bufferedFrames).toBe(3)
    ws.receive({ type: 'ready', asrModel: 'm', device: 'cpu', providers: [], loadS: 7 })
    expect(ws.frames).toBe(3)
    expect(h.svc.bufferedFrames).toBe(0)
    expect(h.traces.some((t) => t.ev === 'sidecar.buffer_flushed' && t.frames === 3)).toBe(true)
    h.svc.sendFrame(frame())
    expect(ws.frames).toBe(4)
    expect(ws.text[0]).toMatchObject({ type: 'config', endpoint: { vadThreshold: 0.5 } })
    expect(h.events.map((e) => e.type)).toEqual(['status', 'ready'])
  })

  it('caps the pending buffer at ten seconds of audio', () => {
    const h = harness()
    h.svc.setListening(true)
    for (let i = 0; i < 400; i++) h.svc.sendFrame(frame())
    expect(h.svc.bufferedFrames).toBe(Math.ceil(10_000 / 32))
  })

  it('reconnects the websocket when it closes while the process is alive, then restarts after repeated drops', async () => {
    const h = harness()
    h.svc.start()
    h.procs[0]!.stdout.write('EAR_PORT 1\n')
    await vi.advanceTimersByTimeAsync(0)
    const first = h.ws()
    first.open()
    first.emit('close', 1006)
    expect(h.statuses.at(-1)).toContain('reconnecting')
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWs.instances).toHaveLength(2)
    const second = h.ws()
    second.open()
    expect(h.traces.filter((t) => t.ev === 'sidecar.connected')).toHaveLength(2)
    // drops that keep coming within the stability window exhaust the schedule; the process is restarted instead
    for (let i = 0; i < 4 && !h.procs[0]!.killed; i++) {
      h.ws().emit('close', 1006)
      await vi.advanceTimersByTimeAsync(5000)
      if (h.ws().readyState !== WebSocket.CLOSED) h.ws().open()
    }
    expect(h.procs[0]!.killed).toBe(true)
    expect(h.statuses.some((s) => s.startsWith('reconnecting'))).toBe(true)
  })

  it('restarts the ears after two missed heartbeats and resets the count on pong', async () => {
    const h = harness()
    h.svc.start()
    h.procs[0]!.stdout.write('EAR_PORT 2\n')
    await vi.advanceTimersByTimeAsync(0)
    const ws = h.ws()
    ws.open()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ws.text.filter((m) => m.type === 'ping')).toHaveLength(1)
    ws.receive({ type: 'pong' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(ws.text.filter((m) => m.type === 'ping')).toHaveLength(3)
    expect(h.procs[0]!.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.procs[0]!.killed).toBe(true)
    expect(h.traces.some((t) => t.ev === 'sidecar.heartbeat_lost')).toBe(true)
  })

  it('reports a clear status instead of guessing a foreign venv when no python is configured', () => {
    const h = harness()
    delete process.env.VA_PYTHON
    expect(h.svc.resolvePython()).toBe('python')
    h.svc.start()
    expect(h.statuses[0]).toContain('Python path')
  })
})
