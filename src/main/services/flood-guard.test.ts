import { describe, expect, it } from 'vitest'
import { FloodGuard } from './flood-guard'

const line = (msg: string, scope = 'ear') => ({ level: 'error' as const, scope, msg })

describe('FloodGuard', () => {
  it('passes the first few repeats, suppresses the rest and summarises when the window closes', () => {
    let now = 0
    const g = new FloodGuard({ windowMs: 10_000, allowPerWindow: 3, maxPerSecond: 100 }, () => now)
    const results = Array.from({ length: 40 }, (_, i) => {
      now = i * 32
      return g.admit(line(`frame processing failed (frame ${i})`)).pass
    })
    expect(results.filter(Boolean)).toHaveLength(3)
    expect(results.slice(0, 3)).toEqual([true, true, true])
    now = 10_001
    const { pass, summaries } = g.admit(line('something else'))
    expect(pass).toBe(true)
    expect(summaries).toEqual([{ level: 'error', scope: 'ear', msg: 'frame processing failed (frame #) (repeated ×37 more in 10s)' }])
  })

  it('templates numbers, quoted strings and ids so variants share one key', () => {
    expect(FloodGuard.template('tts attempt 2 failed: "Edge TTS timed out" for 3f9a2c1e-1111-2222-3333-444455556666 after 12.5s')).toBe(
      'tts attempt # failed: "…" for <id> after #s'
    )
  })

  it('caps lines per scope per second and reports the drop count', () => {
    let now = 0
    const g = new FloodGuard({ windowMs: 10_000, allowPerWindow: 1000, maxPerSecond: 5 }, () => now)
    const passed = Array.from({ length: 12 }, (_, i) => g.admit(line(`distinct message ${String.fromCharCode(65 + i)}`, 'renderer')).pass)
    expect(passed.filter(Boolean)).toHaveLength(5)
    now = 1000
    const { summaries } = g.admit(line('next second', 'renderer'))
    expect(summaries).toEqual([{ level: 'warn', scope: 'renderer', msg: '7 log lines dropped (over 5/s)' }])
  })

  it('does not summarise keys that never repeated', () => {
    let now = 0
    const g = new FloodGuard({ windowMs: 100 }, () => now)
    g.admit(line('once'))
    now = 500
    expect(g.sweep()).toEqual([])
  })
})
