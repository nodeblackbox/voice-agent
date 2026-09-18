import type { SessionSummary, TurnMetrics } from '@shared/types'

export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const v = sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
  return Math.round(v)
}

export const LATENCY_KEYS = ['asrMs', 'ttftMs', 'ttfsMs', 'ttsFirstMs', 'ttfaMs', 'speechEndToAudioMs', 'totalMs'] as const

export function summarize(list: TurnMetrics[]): SessionSummary {
  const latency: SessionSummary['latency'] = {}
  for (const key of LATENCY_KEYS) {
    const values = list.map((m) => m[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    if (values.length) latency[key] = { p50: percentile(values, 0.5)!, p95: percentile(values, 0.95)!, n: values.length }
  }
  return {
    turns: list.length,
    voiceTurns: list.filter((m) => m.asrMs !== undefined).length,
    interrupted: list.filter((m) => m.interrupted).length,
    fallbacks: list.filter((m) => m.fallbackUsed).length,
    stalls: list.filter((m) => m.stallReason).length,
    stepLimits: list.filter((m) => m.hitStepLimit).length,
    fillers: list.reduce((n, m) => n + (m.fillers ?? 0), 0),
    latency
  }
}
