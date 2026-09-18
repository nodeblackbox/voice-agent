import type { AudioChunk, PlaybackSettings } from '@shared/types'
import { DEFAULT_TUNING } from '@shared/tuning'
import { ChunkQueue, isTerminalMarker, type QueuedChunk } from './chunk-queue'
import { rlog } from '../lib/rlog'

interface TurnQueue {
  queue: ChunkQueue<AudioBuffer>
  nextTime: number
  sources: Set<AudioBufferSourceNode>
  pumping: boolean
}

type SinkCapableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

let gapS = DEFAULT_TUNING.playback.gapMs / 1000
let rampS = DEFAULT_TUNING.playback.duckRampMs / 1000

let ctx: SinkCapableContext | null = null
let master: GainNode | null = null
let muted = false
let duck = 1
const turns = new Map<string, TurnQueue>()
let unsubscribed = false

function ensure(): SinkCapableContext {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }
  const c = new AudioContext({ latencyHint: 'interactive' }) as SinkCapableContext
  const g = c.createGain()
  g.gain.value = muted ? 0 : duck
  g.connect(c.destination)
  ctx = c
  master = g
  return c
}

function applyGain(): void {
  if (!ctx || !master) return
  const target = muted ? 0 : duck
  const now = ctx.currentTime
  master.gain.cancelScheduledValues(now)
  master.gain.setValueAtTime(master.gain.value, now)
  master.gain.linearRampToValueAtTime(target, now + rampS)
}

function getTurn(turnId: string): TurnQueue {
  let t = turns.get(turnId)
  if (!t) {
    t = { queue: new ChunkQueue<AudioBuffer>(), nextTime: 0, sources: new Set(), pumping: false }
    turns.set(turnId, t)
  }
  return t
}

function markFinished(turnId: string, t: TurnQueue, seq: number): void {
  if (t.queue.cancelled) return
  window.api.playback.finished(turnId, seq)
  if (t.queue.isLast(seq)) {
    window.api.playback.drained(turnId)
    turns.delete(turnId)
  }
}

function speakWithSystemVoice(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || muted) {
      resolve()
      return
    }
    const u = new SpeechSynthesisUtterance(text)
    u.onend = () => resolve()
    u.onerror = () => resolve()
    window.speechSynthesis.speak(u)
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}

async function pump(turnId: string, t: TurnQueue): Promise<void> {
  if (t.pumping) return
  t.pumping = true
  try {
    for (;;) {
      const item = t.queue.take()
      if (!item) return
      const c = ensure()
      if (item.buffer) {
        const start = Math.max(c.currentTime + gapS, t.nextTime)
        const src = c.createBufferSource()
        src.buffer = item.buffer
        src.connect(master ?? c.destination)
        t.sources.add(src)
        src.onended = () => {
          t.sources.delete(src)
          markFinished(turnId, t, item.seq)
        }
        src.start(start)
        t.nextTime = start + item.buffer.duration
        setTimeout(() => {
          if (!t.queue.cancelled) window.api.playback.started(turnId, item.seq)
        }, (start - c.currentTime) * 1000)
      } else {
        // wait for scheduled audio to finish so ordering and drained() stay truthful
        await wait((t.nextTime - c.currentTime) * 1000)
        if (t.queue.cancelled) return
        window.api.playback.started(turnId, item.seq)
        if (!isTerminalMarker(item)) await speakWithSystemVoice(item.text)
        t.nextTime = c.currentTime
        markFinished(turnId, t, item.seq)
      }
    }
  } finally {
    t.pumping = false
  }
}

async function handleChunk(chunk: AudioChunk): Promise<void> {
  const t = getTurn(chunk.turnId)
  if (t.queue.cancelled) return
  let buffer: AudioBuffer | null = null
  if (chunk.mp3.byteLength > 0) {
    try {
      buffer = await ensure().decodeAudioData(chunk.mp3.slice(0))
    } catch (e) {
      rlog('warn', 'playback', `decode failed for seq ${chunk.seq} (${chunk.mp3.byteLength} bytes): ${e instanceof Error ? e.message : String(e)}`)
      buffer = null
    }
  }
  if (t.queue.cancelled) return
  const item: QueuedChunk<AudioBuffer> =
    !buffer && chunk.mp3.byteLength > 0
      ? // undecodable audio: skip the sentence but keep the sequence moving
        { seq: chunk.seq, text: '', last: chunk.last, buffer: null }
      : { seq: chunk.seq, text: chunk.text, last: chunk.last, buffer }
  t.queue.push(item)
  void pump(chunk.turnId, t)
}

function cancel(turnId: string | null): void {
  const ids = turnId ? [turnId] : [...turns.keys()]
  for (const id of ids) {
    const t = turns.get(id)
    if (!t) continue
    t.queue.cancel()
    for (const s of t.sources) {
      try {
        s.stop()
      } catch {
        // already stopped
      }
    }
    t.sources.clear()
    turns.delete(id)
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

export const playback = {
  context(): AudioContext {
    return ensure()
  },
  master(): GainNode {
    ensure()
    return master as GainNode
  },
  subscribe(): () => void {
    if (unsubscribed) return () => undefined
    const offChunk = window.api.onAudioChunk((c) => void handleChunk(c))
    const offCancel = window.api.onAudioCancel((id) => cancel(id))
    return () => {
      unsubscribed = true
      offChunk()
      offCancel()
    }
  },
  setMuted(v: boolean): void {
    muted = v
    applyGain()
    if (v && 'speechSynthesis' in window) window.speechSynthesis.cancel()
  },
  setDuck(gain: number): void {
    duck = Math.min(1, Math.max(0, gain))
    applyGain()
  },
  configure(p: PlaybackSettings): void {
    gapS = p.gapMs / 1000
    rampS = p.duckRampMs / 1000
  },
  async setOutput(deviceId?: string): Promise<void> {
    const c = ensure()
    if (typeof c.setSinkId !== 'function') return
    try {
      await c.setSinkId(deviceId ?? '')
    } catch (e) {
      rlog('warn', 'playback', `setSinkId(${deviceId ?? 'default'}) failed, falling back to the default output: ${e instanceof Error ? e.message : String(e)}`)
      await c.setSinkId('').catch(() => undefined)
    }
  },
  cancel,
  get playing(): boolean {
    return turns.size > 0
  }
}
