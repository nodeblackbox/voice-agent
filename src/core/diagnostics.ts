// Pure helpers over the session trace: pick out one turn, and render a diagnostics report a
// person (or a fresh Claude session) can read without any other context.

import type { ServiceStatus, SessionSummary } from '@shared/types'
import type { TuningDiff } from '@shared/tuning'
import type { TraceEvent } from './trace'

/** Events belonging to the most recent turn, plus the ear events that led into it. */
export function lastTurnEvents(events: TraceEvent[]): TraceEvent[] {
  let start = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.ev === 'turn.start') {
      start = i
      break
    }
  }
  if (start < 0) return events.slice(-40)
  const turnId = events[start]!.turn
  // walk back over the ear/state events that preceded turn.start (speech_start … final)
  let from = start
  while (from > 0) {
    const e = events[from - 1]!
    if (e.ev === 'turn.end' || e.ev === 'turn.cancel' || e.ev === 'turn.start' || e.ev === 'session.summary') break
    from--
  }
  const out: TraceEvent[] = []
  for (let i = from; i < events.length; i++) {
    const e = events[i]!
    if (i < start || !e.turn || e.turn === turnId) out.push(e)
  }
  return out
}

const OMIT = new Set(['t', 'sid', 'turn', 'ev'])

function compact(e: TraceEvent, maxChars = 160): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(e)) {
    if (OMIT.has(k) || v === undefined || v === null) continue
    const s = typeof v === 'string' ? JSON.stringify(v.length > 60 ? `${v.slice(0, 59)}…` : v) : typeof v === 'object' ? JSON.stringify(v) : String(v)
    parts.push(`${k}=${s}`)
  }
  const line = parts.join(' ')
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line
}

export function timeline(events: TraceEvent[]): string[] {
  const t0 = events[0]?.t ? Date.parse(events[0].t) : NaN
  return events.map((e) => {
    const ms = e.t && Number.isFinite(t0) ? Date.parse(e.t) - t0 : NaN
    const stamp = Number.isFinite(ms) ? `+${String(ms).padStart(6, ' ')}ms` : '        '
    return `${stamp}  ${e.ev.padEnd(22)} ${compact(e)}`
  })
}

export interface DiagnosticsInput {
  app: { version: string; electron?: string; node?: string; chrome?: string; platform: string }
  settings: { modelId: string; fallbackModelId: string; styleId: string; mode: string; stt: { model: string; device: string }; voice: string }
  tuningChanged: TuningDiff[]
  services: ServiceStatus[]
  summary: SessionSummary | null
  selfCutSuspects: number
  lastTurn: TraceEvent[]
  lastStats: TraceEvent | null
  recentErrors: string[]
  logDir: string
  tracePath: string | null
}

export function renderDiagnostics(d: DiagnosticsInput): string {
  const lines: string[] = []
  lines.push(`# Voice Agent diagnostics`, '', `Generated ${new Date().toISOString()} · app ${d.app.version} · electron ${d.app.electron ?? '?'} · node ${d.app.node ?? '?'} · ${d.app.platform}`, '')
  lines.push('## Setup', '', `- model: ${d.settings.modelId} (fallback ${d.settings.fallbackModelId}), style ${d.settings.styleId}, mode ${d.settings.mode}`, `- ears: ${d.settings.stt.model} on ${d.settings.stt.device}; voice ${d.settings.voice}`, `- logs: ${d.logDir}`, `- trace: ${d.tracePath ?? 'none yet'}`, '')
  lines.push('## Services', '', ...d.services.map((s) => `- ${s.name}: ${s.state}${s.detail ? ` — ${s.detail}` : ''}`), '')
  lines.push('## Tuning (values that differ from the defaults)', '')
  if (d.tuningChanged.length) lines.push(...d.tuningChanged.map((c) => `- ${c.group}.${c.key} = ${String(c.value)} (default ${String(c.default)})`))
  else lines.push('- all at defaults')
  lines.push('')
  if (d.summary) {
    const s = d.summary
    lines.push('## Session so far', '', `- turns ${s.turns} (voice ${s.voiceTurns}), interrupted ${s.interrupted}, fallbacks ${s.fallbacks}, stalls ${s.stalls}, step limits ${s.stepLimits}, fillers ${s.fillers}, self-cut suspects ${d.selfCutSuspects}`)
    for (const [k, v] of Object.entries(s.latency)) if (v) lines.push(`- ${k}: p50 ${v.p50} ms, p95 ${v.p95} ms (n=${v.n})`)
    lines.push('')
  }
  if (d.lastStats) {
    lines.push('## Ear stats (last)', '', `- ${compact(d.lastStats, 400)}`, '')
  }
  lines.push('## Last turn', '')
  if (d.lastTurn.length) lines.push('```', ...timeline(d.lastTurn), '```')
  else lines.push('- no turn in this session yet')
  lines.push('')
  lines.push('## Recent errors', '')
  if (d.recentErrors.length) lines.push('```', ...d.recentErrors, '```')
  else lines.push('- none')
  lines.push('')
  lines.push('See docs/DEBUGGING.md for the event vocabulary and docs/TUNING.md for what each parameter does.')
  return lines.join('\n')
}
