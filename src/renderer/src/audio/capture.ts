import { CAPTURE_PROCESSOR_NAME, captureProcessorUrl } from './capture-processor'
import { rlog } from '../lib/rlog'

let ctx: AudioContext | null = null
let stream: MediaStream | null = null
let node: AudioWorkletNode | null = null
let analyser: AnalyserNode | null = null
let starting: Promise<void> | null = null
/** Mic mute: the ears keep receiving frames (their clock is frame-driven) but every sample is zero. */
let muted = false

export class CaptureError extends Error {
  constructor(
    readonly stage: 'permission' | 'device' | 'worklet' | 'context',
    message: string
  ) {
    super(message)
  }
}

async function openMic(deviceId?: string): Promise<MediaStream> {
  const constraints = (exact: boolean): MediaStreamConstraints => ({
    audio: {
      deviceId: deviceId && exact ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })
  try {
    return await navigator.mediaDevices.getUserMedia(constraints(true))
  } catch (e) {
    const err = e as DOMException
    if (err.name === 'NotAllowedError') throw new CaptureError('permission', 'Microphone access was denied.')
    if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      // the saved device is gone (unplugged / re-enumerated); fall back to the default mic
      return navigator.mediaDevices.getUserMedia(constraints(false))
    }
    throw new CaptureError('device', err.message || err.name)
  }
}

export const capture = {
  get active(): boolean {
    return stream !== null
  },

  async start(deviceId?: string): Promise<void> {
    if (starting) return starting
    if (stream) return
    starting = (async () => {
      const media = await openMic(deviceId)
      let c: AudioContext
      try {
        c = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
      } catch (e) {
        rlog('info', 'capture', `16 kHz AudioContext refused (${e instanceof Error ? e.message : String(e)}); resampling in the worklet`)
        c = new AudioContext({ latencyHint: 'interactive' })
      }
      try {
        await c.audioWorklet.addModule(captureProcessorUrl())
      } catch (e) {
        media.getTracks().forEach((t) => t.stop())
        await c.close().catch(() => undefined)
        throw new CaptureError('worklet', `Could not load the audio worklet (${(e as Error).message}).`)
      }
      const source = c.createMediaStreamSource(media)
      const worklet = new AudioWorkletNode(c, CAPTURE_PROCESSOR_NAME, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 })
      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => window.api.voice.sendFrame(muted ? new ArrayBuffer(e.data.byteLength) : e.data)
      source.connect(worklet)
      // taps the mic for the level-reactive animation; nothing downstream
      const an = c.createAnalyser()
      an.fftSize = 512
      an.smoothingTimeConstant = 0.5
      source.connect(an)
      if (c.state === 'suspended') await c.resume()
      ctx = c
      stream = media
      node = worklet
      analyser = an
      const track = media.getAudioTracks()[0]
      const s = track?.getSettings() ?? {}
      rlog('info', 'capture', `mic open: ${track?.label ?? 'unknown'} rate=${c.sampleRate} aec=${String(s.echoCancellation)} ns=${String(s.noiseSuppression)} agc=${String(s.autoGainControl)}`)
    })()
    try {
      await starting
    } finally {
      starting = null
    }
  },

  async stop(): Promise<void> {
    node?.port.close()
    node?.disconnect()
    node = null
    analyser?.disconnect()
    analyser = null
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    const c = ctx
    ctx = null
    if (c) await c.close().catch(() => undefined)
  },

  get sampleRate(): number | null {
    return ctx?.sampleRate ?? null
  },

  /** Frequency data of the open microphone, for the animation; null while the mic is closed. */
  get analyser(): AnalyserNode | null {
    return analyser
  },

  /** While muted the stream stays open and the ears receive silence. */
  setMuted(v: boolean): void {
    muted = v
  },

  get muted(): boolean {
    return muted
  },

  get deviceLabel(): string | null {
    return stream?.getAudioTracks()[0]?.label ?? null
  }
}
