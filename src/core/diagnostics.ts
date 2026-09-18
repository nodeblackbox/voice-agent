// Pure helpers over the session trace: pick out one turn, and render a diagnostics report a
// person (or a fresh Claude session) can read without any other context.

import type { ServiceStatus, SessionAnalysis, SessionSummary, TraceEvent, TuningSuggestion, TurnMetrics } from '@shared/types'
import { TUNING, TUNING_GROUPS, coerceParam, tuningParams, type TuningDiff, type TuningGroup, type TuningValues } from '@shared/tuning'
import { summarize } from './metrics/summary'

/** The turn-taking numbers that explain "it cuts me off" / "it talks over me", straight from the trace. */
export function analyzeSession(events: TraceEvent[]): SessionAnalysis {
  const a: SessionAnalysis = {
    events: events.length,
    spanMin: 0,
    turns: 0,
    voiceTurns: 0,
    endReasons: { done: 0, timeout: 0 },
    timeoutsByCap: {},
    doneAtFirstCheck: 0,
    fillerHolds: 0,
    timeoutLastWords: [],
    turnP: { low: 0, mid: 0, high: 0, confident: 0 },
    mergeable: 0,
    continuations: 0,
    merged: 0,
    segments: 0,
    cancels: { newInput: 0, bargeIn: 0, continuation: 0, other: 0 },
    bargein: { duck: 0, cut: 0, release: 0 },
    selfCutSuspects: 0,
    dropped: 0,
    stalls: 0,
    fallbacks: 0,
    stepLimits: 0,
    noteEchoes: 0,
    asrFailures: 0,
    asrReloads: 0,
    gpuMiB: null,
    crashes: 0,
    latency: {}
  }
  const first = events[0]?.t ? Date.parse(events[0].t) : NaN
  const last = events.at(-1)?.t ? Date.parse(events.at(-1)!.t!) : NaN
  if (Number.isFinite(first) && Number.isFinite(last)) a.spanMin = Math.round(((last - first) / 60000) * 10) / 10
  const words = new Map<string, number>()
  const metrics: TurnMetrics[] = []
  for (const e of events) {
    switch (e.ev) {
      case 'turn.start':
        a.turns++
        if (e.via === 'voice') a.voiceTurns++
        break
      case 'ear.speech_end': {
        const checks = (e.checks as Array<{ p: number; heldOnFiller?: boolean; lastWord?: string }> | undefined) ?? []
        if (e.reason === 'timeout') {
          a.endReasons.timeout++
          const cap = typeof e.capMs === 'number' ? String(e.capMs) : 'unknown'
          a.timeoutsByCap[cap] = (a.timeoutsByCap[cap] ?? 0) + 1
          const w = checks.at(-1)?.lastWord ?? '<none>'
          words.set(w, (words.get(w) ?? 0) + 1)
        } else {
          a.endReasons.done++
          if (checks.length === 1) a.doneAtFirstCheck++
        }
        a.fillerHolds += checks.filter((c) => c.heldOnFiller).length
        const p = typeof e.turnP === 'number' ? e.turnP : null
        if (p !== null) {
          if (p < 0.3) a.turnP.low++
          else if (p < 0.7) a.turnP.mid++
          else if (p < 0.9) a.turnP.high++
          else a.turnP.confident++
        }
        if (typeof e.segments === 'number') a.segments += e.segments
        break
      }
      case 'turn.mergeable':
        a.mergeable++
        break
      case 'turn.continuation':
        a.continuations++
        break
      case 'turn.merged':
        a.merged++
        break
      case 'turn.cancel': {
        const r = String(e.reason)
        if (r === 'new-input') a.cancels.newInput++
        else if (r === 'barge-in') a.cancels.bargeIn++
        else if (r === 'continuation') a.cancels.continuation++
        else a.cancels.other++
        if (e.metrics && typeof e.metrics === 'object') metrics.push(e.metrics as TurnMetrics)
        break
      }
      case 'turn.end':
        if (e.metrics && typeof e.metrics === 'object') metrics.push(e.metrics as TurnMetrics)
        break
      case 'ear.bargein': {
        const s = String(e.stage) as keyof SessionAnalysis['bargein']
        if (s in a.bargein) a.bargein[s]++
        break
      }
      case 'turn.self_cut_suspect':
        a.selfCutSuspects++
        break
      case 'turn.dropped':
        a.dropped++
        break
      case 'turn.stall':
        a.stalls++
        break
      case 'turn.attempt':
        if (e.reason === 'fallback') a.fallbacks++
        break
      case 'turn.step_limit':
        a.stepLimits++
        break
      case 'turn.note_echo':
        a.noteEchoes++
        break
      case 'ear.stats':
        if (typeof e.asrFailures === 'number') a.asrFailures = e.asrFailures
        if (typeof e.asrReloads === 'number') a.asrReloads = e.asrReloads
        if (typeof e.gpuMiB === 'number') a.gpuMiB = e.gpuMiB
        break
      case 'app.crash':
        a.crashes++
        break
      default:
        break
    }
  }
  a.timeoutLastWords = [...words.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)
  a.latency = summarize(metrics).latency
  return a
}

/** The parameter catalogue the tuning advisor reasons over: one line per tunable with its current value. */
export function tuningCatalogue(values: TuningValues): string {
  const lines: string[] = []
  for (const g of TUNING_GROUPS) {
    for (const { key, param } of tuningParams(g)) {
      const current = (values[g] as Record<string, unknown>)[key]
      const range = param.kind === 'number' ? ` range ${param.min}-${param.max} step ${param.step}${param.unit ? ` ${param.unit}` : ''}` : param.kind === 'enum' ? ` one of ${param.options.join('|')}` : param.kind === 'boolean' ? ' true|false' : ' text'
      const cur = typeof current === 'string' && current.length > 60 ? `${current.slice(0, 59)}…` : String(current)
      lines.push(`- ${g}.${key} = ${cur} (default ${String(param.default)};${range}): ${param.doc}`)
    }
  }
  return lines.join('\n')
}

export const TUNING_ADVISOR_SYSTEM = `You tune the turn-taking and latency parameters of a spoken voice assistant from statistics of a real session. You get the parameter catalogue with current values and a JSON analysis of the session trace. Recommend only changes the data supports, at most six, each a single parameter with a concrete value inside its range. Prefer the smallest change that fixes the worst symptom: hard-cap timeouts while the model said "not done" mean the thinking cap (maxSilenceLowMs) or turnLowThreshold; timeouts at the normal cap with mid scores mean maxSilenceMs or turnThreshold; many done-at-first-check ends plus continuations mean fillerHoldsHighTier, fillerWords or the continuation window; self-cut suspects mean bargeInThreshold; slow speech-end-to-audio means firstMinWords or maxTokens. Do not suggest a value equal to the current one. Output only a JSON array: [{"group":"endpoint","key":"maxSilenceLowMs","value":4000,"reason":"..."}]. Reasons are one sentence citing the numbers.`

/** Parse the advisor's JSON, drop unknown keys, clamp values, skip no-ops. */
export function parseSuggestions(text: string, values: TuningValues): TuningSuggestion[] {
  const match = /\[[\s\S]*\]/.exec(text)
  if (!match) return []
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: TuningSuggestion[] = []
  for (const item of raw as Array<Record<string, unknown>>) {
    const group = String(item.group ?? '') as TuningGroup
    const key = String(item.key ?? '')
    const params = (TUNING as Record<string, Record<string, unknown>>)[group]
    if (!params || !(key in params)) continue
    const param = (params as Record<string, Parameters<typeof coerceParam>[0]>)[key]!
    const value = coerceParam(param, item.value)
    const current = (values[group] as Record<string, number | boolean | string>)[key]!
    if (value === current) continue
    out.push({ group, key, value, current, reason: String(item.reason ?? '').slice(0, 300) })
    if (out.length >= 6) break
  }
  return out
}

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
  analysis?: SessionAnalysis
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
  if (d.analysis && d.analysis.voiceTurns > 0) {
    const x = d.analysis
    lines.push('## Turn-taking analysis', '')
    lines.push(`- turn ends: ${x.endReasons.done} by Smart Turn (${x.doneAtFirstCheck} at the first check), ${x.endReasons.timeout} by a hard cap ${JSON.stringify(x.timeoutsByCap)}`)
    lines.push(`- Smart Turn score at the end: <0.3 ${x.turnP.low}, 0.3-0.7 ${x.turnP.mid}, 0.7-0.9 ${x.turnP.high}, ≥0.9 ${x.turnP.confident}; filler holds ${x.fillerHolds}`)
    if (x.timeoutLastWords.length) lines.push(`- last word at timeouts: ${x.timeoutLastWords.map(([w, n]) => `${w} ×${n}`).join(', ')}`)
    lines.push(`- fragments: ${x.mergeable} looked unfinished, ${x.continuations} resumed inside the window, ${x.merged} merged; ${x.segments} long-utterance segments`)
    lines.push(`- cancels: ${x.cancels.newInput} new input, ${x.cancels.bargeIn} barge-in, ${x.cancels.continuation} continuation; barge-in duck ${x.bargein.duck} / cut ${x.bargein.cut} / release ${x.bargein.release}; self-cut suspects ${x.selfCutSuspects}`)
    lines.push(`- dropped finals ${x.dropped}, stalls ${x.stalls}, fallbacks ${x.fallbacks}, step limits ${x.stepLimits}, note echoes ${x.noteEchoes}, ASR failures ${x.asrFailures} (reloads ${x.asrReloads}), crashes ${x.crashes}${x.gpuMiB !== null ? `, GPU ${x.gpuMiB} MiB` : ''}`)
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
