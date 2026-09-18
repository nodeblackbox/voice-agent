import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { app, shell } from 'electron'
import type { LogFileInfo, ServiceStatus, Settings } from '@shared/types'
import { pickTuning, tuningDiff } from '@shared/tuning'
import type { TraceEvent } from '@core/trace'
import { lastTurnEvents, renderDiagnostics } from '@core/diagnostics'
import type { Agent } from '@core/agent'
import { logDir, tracePath } from './log'

export interface DiagnosticsDeps {
  agent: Agent
  settings: () => Settings
  services: () => ServiceStatus[]
}

/** A file name inside the logs directory (or logs/sessions), never a path. */
function safeLogPath(name: string): string | null {
  const dir = logDir()
  if (!dir) return null
  const candidates = [join(dir, basename(name)), join(dir, 'sessions', basename(name))]
  for (const p of candidates) {
    if (resolve(p).startsWith(resolve(dir)) && existsSync(p)) return p
  }
  return null
}

export function listLogs(): LogFileInfo[] {
  const dir = logDir()
  if (!dir || !existsSync(dir)) return []
  const out: LogFileInfo[] = []
  const scan = (folder: string, prefix: string): void => {
    for (const f of readdirSync(folder)) {
      const p = join(folder, f)
      const st = statSync(p)
      if (st.isFile()) out.push({ name: prefix + f, bytes: st.size, modifiedAt: st.mtimeMs })
    }
  }
  scan(dir, '')
  const sessions = join(dir, 'sessions')
  if (existsSync(sessions)) scan(sessions, 'sessions/')
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export function tailLog(name: string, lines = 200): string[] {
  const p = safeLogPath(name.replace(/^sessions\//, ''))
  if (!p) return []
  const all = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
  return all.slice(-Math.max(1, Math.min(lines, 5000)))
}

export function readTrace(sid: string | null, limit = 2000): TraceEvent[] {
  const path = sid ? safeLogPath(`${sid}.jsonl`) : tracePath()
  if (!path || !existsSync(path)) return []
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)
  const out: TraceEvent[] = []
  for (const line of rows.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as TraceEvent)
    } catch {
      // a partially written line at the tail is fine
    }
  }
  return out
}

export function lastTurn(sid: string | null): TraceEvent[] {
  return lastTurnEvents(readTrace(sid))
}

export function diagnosticsReport(d: DiagnosticsDeps): string {
  const s = d.settings()
  const events = readTrace(d.agent.currentSessionId)
  const lastStats = [...events].reverse().find((e) => e.ev === 'ear.stats') ?? null
  return renderDiagnostics({
    app: { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, platform: `${process.platform} ${process.arch}` },
    settings: { modelId: s.modelId, fallbackModelId: s.fallbackModelId, styleId: s.styleId, mode: s.mode, stt: { model: s.stt.model, device: s.stt.device }, voice: s.voice.voice },
    tuningChanged: tuningDiff(pickTuning(s)),
    services: d.services(),
    summary: d.agent.summary(),
    selfCutSuspects: d.agent.selfCutSuspects,
    lastTurn: lastTurnEvents(events),
    lastStats,
    recentErrors: tailLog('errors.log', 30),
    logDir: logDir(),
    tracePath: tracePath()
  })
}

export async function openLogsFolder(): Promise<void> {
  const dir = logDir()
  if (dir) await shell.openPath(dir)
}
