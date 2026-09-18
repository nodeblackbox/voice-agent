import { describe, expect, it, vi } from 'vitest'

const setMetadata = vi.fn(async () => {})
vi.mock('msedge-tts', () => ({
  MsEdgeTTS: class {
    setMetadata = setMetadata
    close = vi.fn()
  },
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' }
}))

import { EdgeTtsEngine, edgeTtsStats, guardStreamPush } from './tts'

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
