import { describe, expect, it, vi } from 'vitest'

const setMetadata = vi.fn(async () => {})
vi.mock('msedge-tts', () => ({
  MsEdgeTTS: class {
    setMetadata = setMetadata
    close = vi.fn()
  },
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' }
}))

import { EdgeTtsEngine, KokoroTtsEngine, edgeRate, edgeTtsStats, guardStreamPush, kokoroSpeed, type KokoroBackend } from './tts'

describe('KokoroTtsEngine', () => {
  const req = { text: 'Hello.', voice: 'en-US-AvaNeural', rate: 0, pitch: 0 }
  const backend = (over: Partial<KokoroBackend> = {}): KokoroBackend => ({
    ready: () => true,
    start: vi.fn(async () => true),
    synth: vi.fn(async () => Buffer.from('RIFF')),
    ...over
  })

  it('starts the backend and hands the sentence to the Windows voice while Kokoro is loading', async () => {
    const b = backend({ ready: () => false })
    const out = await new KokoroTtsEngine(b, () => 'af_heart').synth(req, new AbortController().signal)
    expect(out).toBeNull()
    expect(b.start).toHaveBeenCalled()
    expect(b.synth).not.toHaveBeenCalled()
  })

  it('returns Kokoro audio with its own voice once loaded', async () => {
    const b = backend()
    const out = await new KokoroTtsEngine(b, () => 'bf_emma').synth(req, new AbortController().signal)
    expect(out?.toString()).toBe('RIFF')
    expect(b.synth).toHaveBeenCalledWith('Hello.', 'bf_emma', 1, expect.anything())
  })

  it('falls through to the Windows voice instead of throwing when Kokoro errors', async () => {
    const b = backend({ synth: vi.fn(async () => Promise.reject(new Error('boom'))) })
    expect(await new KokoroTtsEngine(b, () => 'af_heart').synth(req, new AbortController().signal)).toBeNull()
  })

  it('maps the rate offset onto a sane speed', () => {
    expect(kokoroSpeed(0)).toBe(1)
    expect(kokoroSpeed(0.2)).toBe(1.2)
    expect(kokoroSpeed(-0.3)).toBeCloseTo(0.7)
    expect(kokoroSpeed(5)).toBe(2)
  })
})

describe('edgeRate', () => {
  // a bare number in SSML is a multiplier: the +15% slider must not become rate="0.15"
  it('turns the rate offset into a signed SSML percentage', () => {
    expect(edgeRate(0)).toBe('+0%')
    expect(edgeRate(0.15)).toBe('+15%')
    expect(edgeRate(-0.3)).toBe('-30%')
  })
})

describe('guardStreamPush', () => {
  it('forwards frames for live streams and counts frames for missing or destroyed ones', () => {
    const original = vi.fn()
    const push = guardStreamPush(original, 'audio')
    const owner = { _streams: { live: { audio: {} }, dead: { audio: undefined } } as Record<string, Record<string, unknown> | undefined> }
    const before = edgeTtsStats.droppedFrames
    push.call(owner, 'frame', 'live')
    push.call(owner, 'frame', 'dead')
    push.call(owner, 'frame', 'never-registered')
    push.call({}, 'frame', 'live')
    expect(original).toHaveBeenCalledTimes(1)
    expect(original).toHaveBeenCalledWith('frame', 'live')
    expect(edgeTtsStats.droppedFrames - before).toBe(3)
  })
})

describe('EdgeTtsEngine.warm', () => {
  it('opens a socket for the voice, reuses the worker, and never throws', async () => {
    setMetadata.mockClear()
    const engine = new EdgeTtsEngine(1, 1000)
    await expect(engine.warm('en-US-AvaNeural')).resolves.toBe(true)
    await expect(engine.warm('en-US-AvaNeural')).resolves.toBe(true)
    expect(setMetadata).toHaveBeenCalledTimes(2)
    expect(setMetadata).toHaveBeenLastCalledWith('en-US-AvaNeural', 'mp3')
    setMetadata.mockRejectedValueOnce(new Error('offline'))
    await expect(engine.warm('en-US-AvaNeural')).resolves.toBe(false)
  })
})
