import { describe, expect, it, vi } from 'vitest'
import type { AudioChunk } from '@shared/types'
import { Speaker, type SpeakerDeps } from './speaker'
import type { TtsEngine, TtsRequest } from './tts'

const voice = { engine: 'edge' as const, voice: 'en-US-AvaNeural', kokoroVoice: 'af_heart', rate: 0, pitch: 0 }

const engine = (impl: (req: TtsRequest, signal: AbortSignal) => Promise<Buffer | null>): TtsEngine => ({ name: 'edge', synth: impl })
const okEngine = (delayFor: (text: string) => number = () => 0) =>
  engine((req, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(Buffer.from(`mp3:${req.text}`)), delayFor(req.text))
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
  }))

const make = (over: Partial<SpeakerDeps> = {}) => {
  const chunks: AudioChunk[] = []
  const controller = new AbortController()
  const deps: SpeakerDeps = {
    engine: okEngine(),
    fallback: { name: 'system', synth: async () => null },
    voice,
    emit: (c) => chunks.push(c),
    onDegraded: vi.fn(),
    log: vi.fn(),
    ...over
  }
  return { speaker: new Speaker('turn-1', deps, controller.signal), chunks, controller, deps }
}

const text = (b: ArrayBuffer): string => Buffer.from(b).toString()

describe('Speaker', () => {
  it('emits chunks in order with the last flag on the final one', async () => {
    const { speaker, chunks } = make({ engine: okEngine((t) => (t.startsWith('A') ? 30 : 0)) })
    speaker.say('A slow one.')
    speaker.say('B fast one.')
    await speaker.finish()
    expect(chunks.map((c) => [c.seq, text(c.mp3), c.last])).toEqual([
      [0, 'mp3:A slow one.', false],
      [1, 'mp3:B fast one.', true]
    ])
  })

  it('emits a terminal marker when nothing was said', async () => {
    const { speaker, chunks } = make()
    await speaker.finish()
    expect(chunks).toEqual([{ turnId: 'turn-1', seq: 0, text: '', kind: 'speech', mp3: new ArrayBuffer(0), last: true }])
  })

  it('ignores empty text and text after finish or in silent mode', async () => {
    const { speaker, chunks } = make({ silent: true })
    speaker.say('   ')
    speaker.say('Hello.')
    await speaker.finish()
    speaker.say('Too late.')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.last).toBe(true)
  })

  it('retries a failed sentence once, then speaks it with the fallback instead of dropping it', async () => {
    let calls = 0
    const flaky = engine(async (req) => {
      calls++
      if (req.text === 'Bad.') throw new Error('boom')
      return Buffer.from(`mp3:${req.text}`)
    })
    const { speaker, chunks, deps } = make({ engine: flaky })
    speaker.say('Bad.')
    speaker.say('Good.')
    await speaker.finish()
    expect(calls).toBe(3)
    expect(chunks.filter((c) => c.text).map((c) => [c.text, text(c.mp3)])).toEqual([
      ['Bad.', ''],
      ['Good.', 'mp3:Good.']
    ])
    expect(chunks.at(-1)?.last).toBe(true)
    expect(deps.onDegraded).not.toHaveBeenCalled()
  })

  it('degrades to the fallback engine after three consecutive failures', async () => {
    const broken = engine(async () => {
      throw new Error('edge down')
    })
    const { speaker, chunks, deps } = make({ engine: broken })
    for (const s of ['One.', 'Two.', 'Three.', 'Four.']) speaker.say(s)
    await speaker.finish()
    expect(deps.onDegraded).toHaveBeenCalledTimes(1)
    const spoken = chunks.filter((c) => c.text)
    expect(spoken.map((c) => c.text)).toEqual(['One.', 'Two.', 'Three.', 'Four.'])
    for (const c of spoken) expect(c.mp3.byteLength).toBe(0)
    expect(chunks.at(-1)?.last).toBe(true)
  })

  it('degrades on the first sentence when the engine cannot be reached at all', async () => {
    let calls = 0
    const refused = engine(async () => {
      calls++
      throw new Error('Edge TTS WebSocket error: Unexpected server response: 403')
    })
    const { speaker, chunks, deps } = make({ engine: refused })
    speaker.say('One.')
    await new Promise((r) => setTimeout(r, 0))
    speaker.say('Two.')
    await speaker.finish()
    expect(calls).toBe(1)
    expect(deps.onDegraded).toHaveBeenCalledTimes(1)
    expect(chunks.filter((c) => c.text).map((c) => c.text)).toEqual(['One.', 'Two.'])
  })

  it('marks fillers, counts them, and tracks first-sentence synthesis timings', async () => {
    const { speaker, chunks } = make({
      engine: engine(async (req) => {
        req.onFirstByte?.(7)
        return Buffer.from(`mp3:${req.text}`)
      })
    })
    speaker.say('Let me check.', 'filler')
    speaker.say('Real answer here.')
    await speaker.finish()
    expect(chunks.filter((c) => c.text).map((c) => c.kind)).toEqual(['filler', 'speech'])
    expect(speaker.fillers).toBe(1)
    expect(speaker.firstSynthMs).toBeGreaterThanOrEqual(0)
    expect(speaker.firstByteMs).toBe(7)
  })

  it('estimates how long emitted audio keeps it busy', async () => {
    const { speaker } = make()
    expect(speaker.isIdle()).toBe(true)
    speaker.say('x'.repeat(150)) // ~10 s of speech at 15 chars/s
    await speaker.finish()
    expect(speaker.isIdle()).toBe(false)
    expect(speaker.busyForMs()).toBeGreaterThan(8000)
    expect(speaker.isIdle(performance.now() + 11_000)).toBe(true)
  })

  it('stops emitting once aborted and resolves finish', async () => {
    const { speaker, chunks, controller } = make({ engine: okEngine(() => 50) })
    speaker.say('One.')
    speaker.say('Two.')
    const done = speaker.finish()
    controller.abort()
    await done
    expect(chunks).toEqual([])
  })
})
