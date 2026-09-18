import { describe, expect, it } from 'vitest'
import { analyzeSession, lastTurnEvents, parseSuggestions, renderDiagnostics, timeline, tuningCatalogue } from './diagnostics'
import { DEFAULT_TUNING } from '@shared/tuning'
import type { TraceEvent } from './trace'

const at = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString()
const events: TraceEvent[] = [
  { t: at(0), ev: 'turn.start', turn: 'a', text: 'first' },
  { t: at(500), ev: 'turn.end', turn: 'a' },
  { t: at(1000), ev: 'ear.speech_start', earT: 1 },
  { t: at(1800), ev: 'ear.speech_end', reason: 'done', silenceMs: 260, checks: [{ p: 0.93 }] },
  { t: at(1900), ev: 'ear.final', text: 'hello there', asrMs: 90 },
  { t: at(1910), ev: 'turn.start', turn: 'b', text: 'hello there', asrMs: 90 },
  { t: at(2300), ev: 'turn.first_token', turn: 'b', ttftMs: 390 },
  { t: at(2400), ev: 'tts.sentence', turn: 'b', seq: 0, ms: 100 },
  { t: at(2600), ev: 'turn.first_audio', turn: 'b', speechEndToAudioMs: 800 },
  { t: at(3000), ev: 'sidecar.ws_close', code: 1006 },
  { t: at(4000), ev: 'turn.end', turn: 'b', interrupted: false }
]

describe('diagnostics', () => {
  it('slices the last turn including the ear events that led into it', () => {
    const last = lastTurnEvents(events)
    expect(last.map((e) => e.ev)).toEqual(['ear.speech_start', 'ear.speech_end', 'ear.final', 'turn.start', 'turn.first_token', 'tts.sentence', 'turn.first_audio', 'sidecar.ws_close', 'turn.end'])
    expect(lastTurnEvents([])).toEqual([])
    expect(lastTurnEvents([{ ev: 'sidecar.spawn' }])).toEqual([{ ev: 'sidecar.spawn' }])
  })

  it('renders a timeline with relative milliseconds and compact fields', () => {
    const rows = timeline(lastTurnEvents(events))
    expect(rows[0]).toMatch(/^\+ {5}0ms {2}ear\.speech_start/)
    expect(rows[3]).toContain('+   910ms')
    expect(rows[3]).toContain('text="hello there"')
    expect(rows[3]).toContain('asrMs=90')
  })

  it('analyses a session trace into turn-taking statistics', () => {
    const trace: TraceEvent[] = [
      { t: at(0), ev: 'turn.start', via: 'voice' },
      { t: at(100), ev: 'ear.speech_end', reason: 'timeout', capMs: 3000, turnP: 0.05, checks: [{ p: 0.05, lastWord: 'basically' }] },
      { t: at(200), ev: 'ear.speech_end', reason: 'timeout', capMs: 1500, turnP: 0.5, checks: [{ p: 0.5, lastWord: 'basically' }] },
      { t: at(300), ev: 'ear.speech_end', reason: 'done', turnP: 0.95, checks: [{ p: 0.95, lastWord: 'right' }], segments: 2 },
      { t: at(400), ev: 'ear.speech_end', reason: 'done', turnP: 0.8, checks: [{ p: 0.8, heldOnFiller: true }, { p: 0.85 }] },
      { t: at(500), ev: 'turn.mergeable', reason: 'filler' },
      { t: at(600), ev: 'turn.continuation' },
      { t: at(700), ev: 'turn.cancel', reason: 'continuation', metrics: { interrupted: true } },
      { t: at(800), ev: 'turn.merged', parts: 2 },
      { t: at(900), ev: 'turn.start', via: 'voice' },
      { t: at(1000), ev: 'ear.bargein', stage: 'duck' },
      { t: at(1100), ev: 'ear.bargein', stage: 'cut' },
      { t: at(1200), ev: 'turn.cancel', reason: 'barge-in', metrics: { speechEndToAudioMs: 900 } },
      { t: at(1300), ev: 'turn.self_cut_suspect' },
      { t: at(1400), ev: 'turn.end', metrics: { speechEndToAudioMs: 1100, fallbackUsed: true } },
      { t: at(1500), ev: 'turn.attempt', reason: 'fallback' },
      { t: at(1600), ev: 'ear.stats', asrFailures: 2, asrReloads: 1, gpuMiB: 5000 },
      { t: at(60_000), ev: 'app.crash' }
    ]
    const a = analyzeSession(trace)
    expect(a).toMatchObject({
      turns: 2,
      voiceTurns: 2,
      endReasons: { done: 2, timeout: 2 },
      timeoutsByCap: { '3000': 1, '1500': 1 },
      doneAtFirstCheck: 1,
      fillerHolds: 1,
      timeoutLastWords: [['basically', 2]],
      turnP: { low: 1, mid: 1, high: 1, confident: 1 },
      mergeable: 1,
      continuations: 1,
      merged: 1,
      segments: 2,
      cancels: { newInput: 0, bargeIn: 1, continuation: 1, other: 0 },
      bargein: { duck: 1, cut: 1, release: 0 },
      selfCutSuspects: 1,
      fallbacks: 1,
      asrFailures: 2,
      asrReloads: 1,
      gpuMiB: 5000,
      crashes: 1,
      spanMin: 1
    })
    expect(a.latency.speechEndToAudioMs).toEqual({ p50: 1000, p95: 1090, n: 2 })
  })

  it('parses advisor suggestions, clamps them and drops unknown or no-op ones', () => {
    const text = `Here you go:\n[{"group":"endpoint","key":"maxSilenceLowMs","value":99999,"reason":"55 of 60 timeouts had p<0.3"},{"group":"endpoint","key":"vadThreshold","value":0.5,"reason":"same as now"},{"group":"nope","key":"x","value":1},{"group":"brain","key":"groqReasoningEffort","value":"turbo","reason":"bad enum"}]`
    const s = parseSuggestions(text, DEFAULT_TUNING)
    expect(s).toEqual([{ group: 'endpoint', key: 'maxSilenceLowMs', value: 8000, current: 3000, reason: '55 of 60 timeouts had p<0.3' }])
    expect(parseSuggestions('no json here', DEFAULT_TUNING)).toEqual([])
    expect(tuningCatalogue(DEFAULT_TUNING)).toContain('- endpoint.maxSilenceLowMs = 3000 (default 3000; range 1000-8000')
  })

  it('renders a self-contained markdown report', () => {
    const md = renderDiagnostics({
      app: { version: '0.1.0', electron: '44', node: '24', chrome: '140', platform: 'win32' },
      settings: { modelId: 'anthropic:claude-haiku-4-5', fallbackModelId: 'groq:x', styleId: 'short', mode: 'ask', stt: { model: 'parakeet', device: 'hybrid' }, voice: 'en-US-AvaNeural' },
      tuningChanged: [{ group: 'endpoint', key: 'prerollMs', value: 1500, default: 1000 }],
      services: [{ name: 'sidecar', state: 'ready', detail: 'parakeet on hybrid (7.0s)' }],
      summary: { turns: 2, voiceTurns: 1, interrupted: 0, fallbacks: 0, stalls: 0, stepLimits: 0, fillers: 1, latency: { speechEndToAudioMs: { p50: 800, p95: 800, n: 1 } } },
      selfCutSuspects: 0,
      lastTurn: lastTurnEvents(events),
      lastStats: { ev: 'ear.stats', turns: 1, backchannels: 0 },
      recentErrors: ['2026-09-18T10:00:00.000Z WARN  [sidecar] ws error: boom'],
      logDir: 'C:/logs',
      tracePath: 'C:/logs/sessions/s.jsonl'
    })
    expect(md).toContain('# Voice Agent diagnostics')
    expect(md).toContain('- endpoint.prerollMs = 1500 (default 1000)')
    expect(md).toContain('- speechEndToAudioMs: p50 800 ms, p95 800 ms (n=1)')
    expect(md).toContain('turns=1 backchannels=0')
    expect(md).toContain('turn.first_audio')
    expect(md).toContain('ws error: boom')
    expect(md).toContain('docs/DEBUGGING.md')
  })
})
