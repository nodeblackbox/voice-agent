// Streaming replies update the same message a hundred times a second. The renderer only needs the
// latest state every frame or so, and SQLite does not need every token either, so updates to a
// streaming message are held and flushed at a bounded rate; the final (non-streaming) update always
// goes through immediately, in order.

export interface CoalescerTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: CoalescerTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export class Coalescer<T> {
  private pending = new Map<string, T>()
  private handle: unknown = null

  constructor(
    private readonly emit: (value: T) => void,
    private readonly intervalMs: () => number,
    private readonly timers: CoalescerTimers = realTimers
  ) {}

  /** Hold `value` for `key`; the latest value per key is emitted at the next flush. */
  push(key: string, value: T): void {
    const interval = this.intervalMs()
    if (interval <= 0) {
      this.pending.delete(key)
      this.emit(value)
      return
    }
    this.pending.set(key, value)
    if (this.handle === null) this.handle = this.timers.set(() => this.flushAll(), interval)
  }

  /** Emit `value` now, dropping anything held for `key` (the final state supersedes it). */
  now(key: string, value: T): void {
    this.pending.delete(key)
    this.emit(value)
  }

  /** Emit what is held for `key`, if anything. */
  flush(key: string): void {
    const v = this.pending.get(key)
    if (v === undefined) return
    this.pending.delete(key)
    this.emit(v)
  }

  flushAll(): void {
    if (this.handle !== null) {
      this.timers.clear(this.handle)
      this.handle = null
    }
    const items = [...this.pending.values()]
    this.pending.clear()
    for (const v of items) this.emit(v)
  }

  get size(): number {
    return this.pending.size
  }
}
