import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StderrFolder, initLog, log, logAt, logError, sidecarLevel, trace, tracePath } from './log'

let dir: string
let level: 'debug' | 'info' | 'warn' | 'error' = 'info'
let transcripts = true

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'va-log-'))
  level = 'info'
  transcripts = true
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  initLog(dir, { level: () => level, transcripts: () => transcripts, maxBytes: 4000, keepFiles: 3, keepSessions: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const read = (name: string): string[] => (existsSync(join(dir, 'logs', name)) ? readFileSync(join(dir, 'logs', name), 'utf8').trim().split('\n').filter(Boolean) : [])

describe('log', () => {
  it('routes levels: app.log honours the configured level, errors.log gets warn and above', () => {
    logAt('debug', 'x', 'quiet')
    log('x', 'hello')
    logAt('warn', 'x', 'careful')
    logError('x', 'boom', new Error('kaput'))
    expect(read('app.log').map((l) => l.split(' ')[1])).toEqual(['INFO', 'WARN', 'ERROR'])
    expect(read('errors.log')).toHaveLength(2)
    expect(read('errors.log')[1]).toContain('boom: kaput')
    expect(read('errors.log')[1]).toContain('"stack"')
    level = 'debug'
    logAt('debug', 'x', 'now visible')
    expect(read('app.log').at(-1)).toContain('now visible')
  })

  it('rotates app.log when it grows past maxBytes and keeps a bounded number of files', () => {
    initLog(dir, { maxBytes: 400, keepFiles: 3, guard: { allowPerWindow: 1000, maxPerSecond: 100000 } })
    for (let i = 0; i < 40; i++) log('rot', `line ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))} ${'x'.repeat(40)}`)
    expect(existsSync(join(dir, 'logs', 'app.log.1'))).toBe(true)
    expect(existsSync(join(dir, 'logs', 'app.log.2'))).toBe(true)
    expect(existsSync(join(dir, 'logs', 'app.log.3'))).toBe(true)
    expect(existsSync(join(dir, 'logs', 'app.log.4'))).toBe(false)
    expect(read('app.log').length).toBeLessThan(10)
  })

  it('collapses a repeating fault into a few lines plus a summary', () => {
    vi.useFakeTimers()
    for (let i = 0; i < 100; i++) logAt('error', 'ear', `frame processing failed (frame ${i})`)
    expect(read('errors.log')).toHaveLength(3)
    vi.setSystemTime(Date.now() + 11_000)
    logAt('error', 'ear', 'a different fault')
    const lines = read('errors.log')
    expect(lines.some((l) => l.includes('(repeated ×97 more in 10s)'))).toBe(true)
    vi.useRealTimers()
  })

  it('writes session traces as JSONL with a timestamp and redacts transcripts when asked', () => {
    trace({ ev: 'turn.start', sid: 's1', turn: 't1', text: 'hello there', via: 'voice' })
    trace({ ev: 'sidecar.ready', loadS: 7.1 })
    const path = tracePath()!
    expect(path.endsWith(join('sessions', 's1.jsonl'))).toBe(true)
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(rows[0]).toMatchObject({ ev: 'turn.start', sid: 's1', turn: 't1', text: 'hello there' })
    expect(typeof rows[0]!.t).toBe('string')
    expect(rows[1]).toMatchObject({ ev: 'sidecar.ready', sid: 's1', loadS: 7.1 })
    transcripts = false
    trace({ ev: 'turn.end', sid: 's1', spokenText: 'four words were said' })
    const last = JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as Record<string, unknown>
    expect(last.spokenText).toBe('[20 chars]')
  })

  it('never writes VAD-level spam even if asked repeatedly, via the trace ceiling', () => {
    for (let i = 0; i < 400; i++) trace({ ev: 'ear.level', sid: 's2', p: i / 400 })
    const rows = readFileSync(tracePath()!, 'utf8').trim().split('\n')
    expect(rows.length).toBeLessThanOrEqual(51)
  })

  it('prunes old session files beyond keepSessions', () => {
    trace({ ev: 'a', sid: 'old-1' })
    trace({ ev: 'a', sid: 'old-2' })
    trace({ ev: 'a', sid: 'new-3' })
    const files = ['old-1', 'old-2', 'new-3'].map((s) => existsSync(join(dir, 'logs', 'sessions', `${s}.jsonl`)))
    expect(files.filter(Boolean).length).toBeLessThanOrEqual(2)
    expect(files[2]).toBe(true)
  })

  it('folds a python traceback into one entry and leaves other lines alone', () => {
    const f = new StderrFolder()
    const lines = [
      '12:00:00 INFO ear.pipeline: final asr_ms=5',
      'Traceback (most recent call last):',
      '  File "D:\\x\\pipeline.py", line 341, in _partial_job',
      '    text = self.asr.recognize(audio[-SR * 15:])',
      '           ^^^^^^^^^^^^^^^^^^^^',
      'onnxruntime.capi.onnxruntime_pybind11_state.Fail: [ONNXRuntimeError] : 1 : FAIL : CUBLAS failure 3',
      '12:00:01 WARNING ear.pipeline: partial decode failed: repeated 10 more times'
    ]
    const out = lines.flatMap((l) => f.push(l))
    expect(out).toHaveLength(3)
    expect(out[1]!.split('\n')).toHaveLength(5)
    expect(out[1]).toMatch(/^Traceback/)
    expect(out[1]).toMatch(/CUBLAS failure 3$/)
    expect(sidecarLevel(out[1]!).level).toBe('warn')
    expect(out[2]).toContain('WARNING')
    expect(f.flush()).toEqual([])
    f.push('Traceback (most recent call last):')
    f.push('  File "x", line 1')
    expect(f.flush()).toEqual(['Traceback (most recent call last):\n  File "x", line 1'])
  })

  it('parses sidecar stderr levels', () => {
    expect(sidecarLevel('12:00:01 WARNING ear.pipeline: config: ignored endpoint keys [x]')).toEqual({ level: 'warn', msg: 'ear.pipeline: config: ignored endpoint keys [x]' })
    expect(sidecarLevel('12:00:01 ERROR ear: model load failed')).toMatchObject({ level: 'error' })
    expect(sidecarLevel('Traceback (most recent call last):')).toMatchObject({ level: 'warn' })
    expect(sidecarLevel('some onnxruntime note')).toMatchObject({ level: 'info' })
  })
})
