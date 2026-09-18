import { describe, expect, it } from 'vitest'
import { lastTurnEvents, renderDiagnostics, timeline } from './diagnostics'
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
