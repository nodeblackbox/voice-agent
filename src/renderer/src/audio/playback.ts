import type { AudioChunk, PlaybackSettings } from '@shared/types'
import { DEFAULT_TUNING } from '@shared/tuning'
import { ChunkQueue, isTerminalMarker, type QueuedChunk } from './chunk-queue'
import { rlog } from '../lib/rlog'

interface LiveSource {
  seq: number
  startAt: number
  duration: number
}

interface TurnQueue {
  queue: ChunkQueue<AudioBuffer>
  nextTime: number
  sources: Set<AudioBufferSourceNode>
  live: Map<AudioBufferSourceNode, LiveSource>
  kinds: Map<number, AudioChunk['kind']>
  pumping: boolean
}

type SinkCapableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

let gapS = DEFAULT_TUNING.playback.gapMs / 1000
const FIRST_GAP_S = 0.005
/** Arrival -> scheduled later than this is logged: the UI thread starved the audio path. */
const LATE_SCHEDULE_MS = 250
let rampS = DEFAULT_TUNING.playback.duckRampMs / 1000

let ctx: SinkCapableContext | null = null
let master: GainNode | null = null
let analyser: AnalyserNode | null = null
let muted = false
let duck = 1
const turns = new Map<string, TurnQueue>()
let unsubscribed = false

export interface Speaking {
  turnId: string
  seq: number
  text: string
  kind: AudioChunk['kind']
}

/** What the transcript needs to show where the voice is: chunk texts per turn and the chunk playing now. */
const speakingListeners = new Set<(s: Speaking | null) => void>()
const chunkListeners = new Set<(turnId: string, chunk: { seq: number; text: string; kind: AudioChunk['kind'] }) => void>()
let speakingNow: Speaking | null = null

function setSpeaking(s: Speaking | null): void {
  if (s === null && speakingNow === null) return
  if (s && speakingNow && s.turnId === speakingNow.turnId && s.seq === speakingNow.seq) return
  speakingNow = s
  for (const fn of speakingListeners) fn(s)
}

function ensure(): SinkCapableContext {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }
  const c = new AudioContext({ latencyHint: 'interactive' }) as SinkCapableContext
  const g = c.createGain()
  g.gain.value = muted ? 0 : duck
  g.connect(c.destination)
  // taps what is actually heard (after ducking/mute) for the level-reactive animation
  const an = c.createAnalyser()
  an.fftSize = 512
  an.smoothingTimeConstant = 0.5
  g.connect(an)
  ctx = c
  master = g
  analyser = an
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
    t = { queue: new ChunkQueue<AudioBuffer>(), nextTime: 0, sources: new Set(), live: new Map(), kinds: new Map(), pumping: false }
    turns.set(turnId, t)
  }
  return t
}

function markFinished(turnId: string, t: TurnQueue, seq: number): void {
  if (t.queue.cancelled) return
  window.api.playback.finished(turnId, seq)
  if (speakingNow?.turnId === turnId && speakingNow.seq === seq) setSpeaking(null)
  if (t.queue.isLast(seq)) {
    window.api.playback.drained(turnId)
    turns.delete(turnId)
    setSpeaking(null)
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
        // The first chunk after silence needs no lead: nothing is queued that it could collide with.
        const lead = t.nextTime <= c.currentTime ? Math.min(gapS, FIRST_GAP_S) : gapS
        const start = Math.max(c.currentTime + lead, t.nextTime)
        const src = c.createBufferSource()
        src.buffer = item.buffer
        src.connect(master ?? c.destination)
        t.sources.add(src)
        t.live.set(src, { seq: item.seq, startAt: start, duration: item.buffer.duration })
        src.onended = () => {
          t.sources.delete(src)
          t.live.delete(src)
          markFinished(turnId, t, item.seq)
        }
        src.start(start)
        t.nextTime = start + item.buffer.duration
        if (item.receivedAt !== undefined) {
          const lateMs = Math.round(performance.now() - item.receivedAt)
          if (lateMs > LATE_SCHEDULE_MS) rlog('warn', 'playback', `seq ${item.seq} scheduled ${lateMs} ms after it arrived; the UI thread is busy`)
        }
        setTimeout(() => {
          if (t.queue.cancelled) return
          window.api.playback.started(turnId, item.seq, item.emittedAt)
          setSpeaking({ turnId, seq: item.seq, text: item.text, kind: t.kinds.get(item.seq) ?? 'speech' })
        }, (start - c.currentTime) * 1000)
      } else {
        // wait for scheduled audio to finish so ordering and drained() stay truthful
        await wait((t.nextTime - c.currentTime) * 1000)
        if (t.queue.cancelled) return
        window.api.playback.started(turnId, item.seq, item.emittedAt)
        if (!isTerminalMarker(item)) {
          setSpeaking({ turnId, seq: item.seq, text: item.text, kind: t.kinds.get(item.seq) ?? 'speech' })
          await speakWithSystemVoice(item.text)
        }
        t.nextTime = c.currentTime
        markFinished(turnId, t, item.seq)
      }
    }
  } finally {
    t.pumping = false
  }
}

async function handleChunk(chunk: AudioChunk): Promise<void> {
  const receivedAt = performance.now()
  const t = getTurn(chunk.turnId)
  if (t.queue.cancelled) return
  t.kinds.set(chunk.seq, chunk.kind)
  if (chunk.text) for (const fn of chunkListeners) fn(chunk.turnId, { seq: chunk.seq, text: chunk.text, kind: chunk.kind })
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
        { seq: chunk.seq, text: '', last: chunk.last, buffer: null, emittedAt: chunk.emittedAt, receivedAt }
      : { seq: chunk.seq, text: chunk.text, last: chunk.last, buffer, emittedAt: chunk.emittedAt, receivedAt }
  t.queue.push(item)
  void pump(chunk.turnId, t)
}

function cancel(turnId: string | null): void {
  const ids = turnId ? [turnId] : [...turns.keys()]
  for (const id of ids) {
    const t = turns.get(id)
    if (!t) continue
    t.queue.cancel()
    // tell main how far into the current sentence the cut landed, so "what was heard" is exact
    const now = ctx?.currentTime ?? 0
    for (const [, l] of t.live) {
      if (now >= l.startAt && now < l.startAt + l.duration) window.api.playback.cancelled(id, l.seq, now - l.startAt, l.duration)
    }
    t.live.clear()
    for (const s of t.sources) {
      try {
        s.stop()
      } catch {
        // already stopped
      }
    }
    t.sources.clear()
    turns.delete(id)
    if (speakingNow?.turnId === id) setSpeaking(null)
  }
  if (turnId === null) setSpeaking(null)
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
  /** Frequency data of the voice being played; null until the first sound (never creates a context). */
  currentAnalyser(): AnalyserNode | null {
    return analyser
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
  configure(p: PlaybackSettings | undefined): void {
    // a main process older than this renderer (dev hot reload) may not send the group yet
    if (!p) return
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
  /** The chunk playing right now (null between turns); fires on every change. */
  onSpeaking(fn: (s: Speaking | null) => void): () => void {
    speakingListeners.add(fn)
    return () => speakingListeners.delete(fn)
  },
  /** Every sentence chunk as it arrives, before it plays, so the transcript can map text to audio. */
  onChunk(fn: (turnId: string, chunk: { seq: number; text: string; kind: AudioChunk['kind'] }) => void): () => void {
    chunkListeners.add(fn)
    return () => chunkListeners.delete(fn)
  },
  get playing(): boolean {
    return turns.size > 0
  }
}
