import { describe, expect, it } from 'vitest'
import { percentile, summarize } from './summary'

describe('summary', () => {
  it('computes interpolated percentiles', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([100], 0.95)).toBe(100)
    expect(percentile([100, 200, 300, 400], 0.5)).toBe(250)
    expect(percentile([100, 200, 300, 400, 1000], 0.95)).toBe(880)
  })

  it('summarises a session of turn metrics', () => {
    const s = summarize([
      { asrMs: 90, ttftMs: 400, speechEndToAudioMs: 900, rendererMs: 30, fillers: 1 },
      { asrMs: 110, ttftMs: 600, speechEndToAudioMs: 1100, rendererMs: 3200, interrupted: true, fallbackUsed: true },
      { ttftMs: 500, stallReason: 'the model stopped mid-answer', hitStepLimit: true }
    ])
    expect(s).toMatchObject({ turns: 3, voiceTurns: 2, interrupted: 1, fallbacks: 1, stalls: 1, stepLimits: 1, fillers: 1 })
    expect(s.latency.asrMs).toEqual({ p50: 100, p95: 109, n: 2 })
    expect(s.latency.speechEndToAudioMs?.n).toBe(2)
    expect(s.latency.rendererMs).toEqual({ p50: 1615, p95: 3042, n: 2 })
    expect(s.latency.ttsFirstMs).toBeUndefined()
  })
})
