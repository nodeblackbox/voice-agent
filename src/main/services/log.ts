import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { redactTranscript, type TraceEvent } from '@core/trace'
import { FloodGuard, type FloodGuardOptions, type LogLevel, type LogLine } from './flood-guard'

export type { LogLevel } from './flood-guard'

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface LogOptions {
  /** Minimum level written to app.log (errors.log always gets warn and above). */
  level?: () => LogLevel
  /** When false, spoken/typed text in trace events is replaced by its length. */
  transcripts?: () => boolean
  maxBytes?: number
  keepFiles?: number
  keepSessions?: number
  guard?: FloodGuardOptions
}

class RotatingFile {
  private size = 0

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
    private readonly keep: number
  ) {
    try {
      this.size = existsSync(path) ? statSync(path).size : 0
    } catch {
      this.size = 0
    }
  }

  append(line: string): void {
    const bytes = Buffer.byteLength(line) + 1
    if (this.size + bytes > this.maxBytes && this.size > 0) this.rotate()
    appendFileSync(this.path, line + '\n')
    this.size += bytes
  }

  private rotate(): void {
    try {
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = `${this.path}.${i}`
        if (existsSync(from)) renameSync(from, `${this.path}.${i + 1}`)
      }
      renameSync(this.path, `${this.path}.1`)
    } catch {
      // rotation is best effort; keep appending to the current file
    }
    this.size = 0
  }
}

let dir = ''
let levelFn: () => LogLevel = () => 'info'
let transcriptsFn: () => boolean = () => true
let keepSessions = 50
let appFile: RotatingFile | null = null
let errFile: RotatingFile | null = null
let guard = new FloodGuard()
let traceGuard = new FloodGuard({ windowMs: 1000, allowPerWindow: 50, maxPerSecond: 200 })
let sweepTimer: NodeJS.Timeout | null = null
let currentSession: { sid: string; path: string } | null = null

export function initLog(userData: string, opts: LogOptions = {}): void {
  dir = join(userData, 'logs')
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
  const keep = opts.keepFiles ?? 3
  appFile = new RotatingFile(join(dir, 'app.log'), maxBytes, keep)
  errFile = new RotatingFile(join(dir, 'errors.log'), maxBytes, keep)
  levelFn = opts.level ?? (() => 'info')
  transcriptsFn = opts.transcripts ?? (() => true)
  keepSessions = opts.keepSessions ?? 50
  guard = new FloodGuard(opts.guard)
  traceGuard = new FloodGuard({ windowMs: 1000, allowPerWindow: 50, maxPerSecond: 200 })
  currentSession = null
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = setInterval(() => {
    for (const s of guard.sweep()) writeLine(s)
  }, 5000)
  sweepTimer.unref?.()
}

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data)
  } catch {
    return '[unserialisable]'
  }
}

function writeLine(l: LogLine, data?: unknown): void {
  const line = `${new Date().toISOString()} ${l.level.toUpperCase().padEnd(5)} [${l.scope}] ${l.msg}${data !== undefined ? ' ' + safeJson(data) : ''}`
  if (l.level === 'error') console.error(line)
  else console.log(line)
  if (!dir) return
  try {
    if (ORDER[l.level] >= ORDER[levelFn()]) appFile?.append(line)
    if (ORDER[l.level] >= ORDER.warn) errFile?.append(line)
  } catch {
    // logging must never take the app down
  }
}

export function logAt(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  const { pass, summaries } = guard.admit({ level, scope, msg })
  for (const s of summaries) writeLine(s)
  if (pass) writeLine({ level, scope, msg }, data)
}

export function log(scope: string, msg: string): void {
  logAt('info', scope, msg)
}

export function logError(scope: string, msg: string, err: unknown): void {
  const e = err as { message?: string; stack?: string } | undefined
  const text = e?.message ?? String(err)
  logAt('error', scope, `${msg}: ${text}`, e?.stack ? { stack: e.stack.split('\n').slice(0, 8).join('\n') } : undefined)
}

export function logDir(): string {
  return dir
}

function pruneSessions(): void {
  try {
    const sessionsDir = join(dir, 'sessions')
    const files = readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: statSync(join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    // called before the new session file exists, so leave one slot for it
    for (const { f } of files.slice(Math.max(0, keepSessions - 1))) unlinkSync(join(sessionsDir, f))
  } catch {
    // best effort
  }
}

export function openSessionTrace(sid: string): void {
  if (!dir || currentSession?.sid === sid) return
  currentSession = { sid, path: join(dir, 'sessions', `${sid}.jsonl`) }
  pruneSessions()
}

export function tracePath(): string | null {
  return currentSession?.path ?? null
}

/** Append one structured event to the session trace. Events without `sid` go to the current session. */
export function trace(event: TraceEvent): void {
  if (!dir) return
  const sid = event.sid ?? currentSession?.sid
  if (!sid) return
  if (currentSession?.sid !== sid) openSessionTrace(sid)
  const { pass, summaries } = traceGuard.admit({ level: 'info', scope: 'trace', msg: event.ev })
  const lines: TraceEvent[] = summaries.map((s) => ({ ev: 'trace.dropped', note: s.msg }))
  if (pass) lines.push(event)
  try {
    for (const e of lines) {
      const body = transcriptsFn() ? e : redactTranscript(e)
      appendFileSync(currentSession!.path, JSON.stringify({ t: new Date().toISOString(), ...body, sid }) + '\n')
    }
  } catch {
    // never fail the caller
  }
}

/** Parse one line of the Python sidecar's stderr into a level; unknown formats are info. */
export function sidecarLevel(line: string): { level: LogLevel; msg: string } {
  const m = /^\d\d:\d\d:\d\d (DEBUG|INFO|WARNING|ERROR|CRITICAL) (\S+): (.*)$/.exec(line)
  if (!m) return { level: /error|traceback|exception/i.test(line) ? 'warn' : 'info', msg: line }
  const lvl = m[1]!
  const level: LogLevel = lvl === 'DEBUG' ? 'debug' : lvl === 'INFO' ? 'info' : lvl === 'WARNING' ? 'warn' : 'error'
  return { level, msg: `${m[2]}: ${m[3]}` }
}
