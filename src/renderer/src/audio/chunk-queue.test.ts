import { describe, expect, it } from 'vitest'
import { ChunkQueue, isTerminalMarker } from './chunk-queue'

const chunk = (seq: number, opts: Partial<{ text: string; last: boolean; buffer: string | null }> = {}) => ({
  seq,
  text: opts.text ?? `s${seq}`,
  last: opts.last ?? false,
  buffer: opts.buffer === undefined ? `buf${seq}` : opts.buffer
})

describe('ChunkQueue', () => {
  it('hands out chunks in sequence when they arrive in order', () => {
    const q = new ChunkQueue<string>()
    q.push(chunk(0))
    q.push(chunk(1))
    expect(q.take()?.seq).toBe(0)
    expect(q.take()?.seq).toBe(1)
    expect(q.take()).toBeUndefined()
  })

  it('holds an out-of-order chunk until its predecessor arrives', () => {
    const q = new ChunkQueue<string>()
    q.push(chunk(1))
    expect(q.take()).toBeUndefined()
    expect(q.pending).toBe(1)
    q.push(chunk(0))
    expect(q.take()?.seq).toBe(0)
    expect(q.take()?.seq).toBe(1)
    expect(q.pending).toBe(0)
  })

  it('tracks the last seq and reports it only for that seq', () => {
    const q = new ChunkQueue<string>()
    q.push(chunk(0))
    q.push(chunk(1, { last: true }))
    expect(q.finalSeq).toBe(1)
    expect(q.isLast(0)).toBe(false)
    expect(q.isLast(1)).toBe(true)
  })

  it('treats a terminal marker as playable-nothing that still closes the turn', () => {
    const q = new ChunkQueue<string>()
    q.push(chunk(0))
    q.push(chunk(1, { text: '', buffer: null, last: true }))
    expect(q.take()?.seq).toBe(0)
    const marker = q.take()
    expect(marker).toBeDefined()
    expect(isTerminalMarker(marker!)).toBe(true)
    expect(q.isLast(marker!.seq)).toBe(true)
  })

  it('accepts a lone terminal marker with no prior audio', () => {
    const q = new ChunkQueue<string>()
    q.push(chunk(0, { text: '', buffer: null, last: true }))
    const only = q.take()
    expect(only && isTerminalMarker(only)).toBe(true)
    expect(q.isLast(0)).toBe(true)
  })

  it('does not treat a system-voice fallback chunk as terminal', () => {
    expect(isTerminalMarker({ text: 'hello', buffer: null })).toBe(false)
    expect(isTerminalMarker({ text: '', buffer: 'x' })).toBe(false)
  })

  it('cancel clears pending chunks and refuses new ones', () => {
    const q = new ChunkQueue<string>()
    q.push(chunk(0))
    q.push(chunk(2))
    q.cancel()
    expect(q.cancelled).toBe(true)
    expect(q.pending).toBe(0)
    expect(q.take()).toBeUndefined()
    q.push(chunk(1))
    expect(q.pending).toBe(0)
  })

  it('keeps advancing nextSeq as chunks are taken', () => {
    const q = new ChunkQueue<string>()
    q.push(chunk(0))
    q.push(chunk(1))
    q.push(chunk(2))
    q.take()
    q.take()
    expect(q.nextSeq).toBe(2)
  })
})
