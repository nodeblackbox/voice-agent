import { describe, expect, it } from 'vitest'
import { Coalescer, type CoalescerTimers } from './coalesce'

function fakeTimers(): CoalescerTimers & { fire(): void; scheduled: number[] } {
  let fn: (() => void) | null = null
  const scheduled: number[] = []
  return {
    scheduled,
    set(f, ms) {
      fn = f
      scheduled.push(ms)
      return 1
    },
    clear() {
      fn = null
    },
    fire() {
      const f = fn
      fn = null
      f?.()
    }
  }
}

describe('Coalescer', () => {
  it('emits only the latest value per key when the timer fires', () => {
    const out: string[] = []
    const timers = fakeTimers()
    const c = new Coalescer<string>((v) => out.push(v), () => 40, timers)
    c.push('a', 'a1')
    c.push('a', 'a2')
    c.push('b', 'b1')
    expect(out).toEqual([])
    expect(timers.scheduled).toEqual([40])
    timers.fire()
    expect(out).toEqual(['a2', 'b1'])
    expect(c.size).toBe(0)
  })

  it('now() bypasses the hold and drops the stale pending value', () => {
    const out: string[] = []
    const timers = fakeTimers()
    const c = new Coalescer<string>((v) => out.push(v), () => 40, timers)
    c.push('a', 'streaming')
    c.now('a', 'final')
    timers.fire()
    expect(out).toEqual(['final'])
  })

  it('an interval of 0 emits immediately', () => {
    const out: string[] = []
    const timers = fakeTimers()
    const c = new Coalescer<string>((v) => out.push(v), () => 0, timers)
    c.push('a', 'x')
    expect(out).toEqual(['x'])
    expect(timers.scheduled).toEqual([])
  })

  it('flush(key) and flushAll() emit early and cancel the timer', () => {
    const out: string[] = []
    const timers = fakeTimers()
    const c = new Coalescer<string>((v) => out.push(v), () => 40, timers)
    c.push('a', 'a1')
    c.push('b', 'b1')
    c.flush('a')
    expect(out).toEqual(['a1'])
    c.flushAll()
    expect(out).toEqual(['a1', 'b1'])
    timers.fire()
    expect(out).toEqual(['a1', 'b1'])
  })
})
