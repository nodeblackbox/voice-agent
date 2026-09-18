import { describe, expect, it, vi } from 'vitest'
import { edgeTtsStats, guardStreamPush } from './tts'

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
