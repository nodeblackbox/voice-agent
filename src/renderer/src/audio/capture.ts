import { CAPTURE_PROCESSOR_NAME, CAPTURE_PROCESSOR_SOURCE } from './capture-processor'

let ctx: AudioContext | null = null
let stream: MediaStream | null = null
let node: AudioWorkletNode | null = null
let moduleUrl: string | null = null
let starting: Promise<void> | null = null

async function loadModule(c: AudioContext): Promise<void> {
  if (!moduleUrl) {
    moduleUrl = URL.createObjectURL(new Blob([CAPTURE_PROCESSOR_SOURCE], { type: 'application/javascript' }))
  }
  await c.audioWorklet.addModule(moduleUrl)
}

export const capture = {
  get active(): boolean {
    return stream !== null
  },

  async start(deviceId?: string): Promise<void> {
    if (starting) return starting
    if (stream) return
    starting = (async () => {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      let c: AudioContext
      try {
        c = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
      } catch {
        c = new AudioContext({ latencyHint: 'interactive' })
      }
      await loadModule(c)
      const source = c.createMediaStreamSource(media)
      const worklet = new AudioWorkletNode(c, CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1
      })
      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => window.api.voice.sendFrame(e.data)
      source.connect(worklet)
      if (c.state === 'suspended') await c.resume()
      ctx = c
      stream = media
      node = worklet
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
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    const c = ctx
    ctx = null
    if (c) await c.close().catch(() => undefined)
  }
}
