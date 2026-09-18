// Keeps a repeating fault from filling the logs. Lines are keyed by level + scope + a template of
// the message (numbers and quoted strings stripped). The first `allowPerWindow` lines of a key pass;
// the rest are counted and summarised once the window closes. A per-scope ceiling drops anything
// above `maxPerSecond`, again with a count instead of silence.

import type { LogLevel } from '@shared/types'

export type { LogLevel }

export interface LogLine {
  level: LogLevel
  scope: string
  msg: string
}

export interface FloodGuardOptions {
  windowMs?: number
  allowPerWindow?: number
  maxPerSecond?: number
}

interface KeyState {
  first: number
  passed: number
  suppressed: number
  line: LogLine
}

interface ScopeState {
  second: number
  count: number
  dropped: number
}

export class FloodGuard {
  private readonly windowMs: number
  private readonly allowPerWindow: number
  private readonly maxPerSecond: number
  private keys = new Map<string, KeyState>()
  private scopes = new Map<string, ScopeState>()

  constructor(
    opts: FloodGuardOptions = {},
    private readonly now: () => number = () => Date.now()
  ) {
    this.windowMs = opts.windowMs ?? 10_000
    this.allowPerWindow = opts.allowPerWindow ?? 3
    this.maxPerSecond = opts.maxPerSecond ?? 20
  }

  static template(msg: string): string {
    return msg
      .replace(/"[^"]*"/g, '"…"')
      .replace(/'[^']*'/g, "'…'")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      .replace(/\d+(\.\d+)?/g, '#')
  }

  /** Decide whether `line` is written. `summaries` are lines to write regardless (they never re-enter the guard). */
  admit(line: LogLine): { pass: boolean; summaries: LogLine[] } {
    const now = this.now()
    const summaries = this.sweep(now)

    const sec = Math.floor(now / 1000)
    let s = this.scopes.get(line.scope)
    if (!s || s.second !== sec) {
      if (s && s.dropped > 0) summaries.push({ level: 'warn', scope: line.scope, msg: `${s.dropped} log lines dropped (over ${this.maxPerSecond}/s)` })
      s = { second: sec, count: 0, dropped: 0 }
      this.scopes.set(line.scope, s)
    }
    if (s.count >= this.maxPerSecond) {
      s.dropped++
      return { pass: false, summaries }
    }

    const key = `${line.level}|${line.scope}|${FloodGuard.template(line.msg)}`
    let k = this.keys.get(key)
    if (!k) {
      k = { first: now, passed: 0, suppressed: 0, line }
      this.keys.set(key, k)
    }
    if (k.passed < this.allowPerWindow) {
      k.passed++
      s.count++
      return { pass: true, summaries }
    }
    k.suppressed++
    return { pass: false, summaries }
  }

  /** Close expired windows; returns one summary line per key that had suppressed repeats. */
  sweep(now: number = this.now()): LogLine[] {
    const out: LogLine[] = []
    for (const [key, k] of this.keys) {
      if (now - k.first < this.windowMs) continue
      this.keys.delete(key)
      if (k.suppressed > 0) {
        out.push({ level: k.line.level, scope: k.line.scope, msg: `${FloodGuard.template(k.line.msg)} (repeated ×${k.suppressed} more in ${Math.round(this.windowMs / 1000)}s)` })
      }
    }
    return out
  }
}
