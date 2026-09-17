import { playback } from './playback'

let nodes: { oscA: OscillatorNode; oscB: OscillatorNode; lfo: OscillatorNode; gain: GainNode; lfoGain: GainNode } | null = null

const LEVEL = Math.pow(10, -28 / 20)

export const cue = {
  start(): void {
    if (nodes) return
    const ctx = playback.context()
    const gain = ctx.createGain()
    gain.gain.value = 0
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 1.6
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = LEVEL * 0.5
    lfo.connect(lfoGain)
    lfoGain.connect(gain.gain)
    const oscA = ctx.createOscillator()
    oscA.type = 'sine'
    oscA.frequency.value = 440
    const oscB = ctx.createOscillator()
    oscB.type = 'sine'
    oscB.frequency.value = 443
    oscA.connect(gain)
    oscB.connect(gain)
    gain.connect(playback.master())
    const now = ctx.currentTime
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(LEVEL, now + 0.25)
    oscA.start()
    oscB.start()
    lfo.start()
    nodes = { oscA, oscB, lfo, gain, lfoGain }
  },

  stop(): void {
    const n = nodes
    if (!n) return
    nodes = null
    const ctx = playback.context()
    const now = ctx.currentTime
    n.gain.gain.cancelScheduledValues(now)
    n.gain.gain.setValueAtTime(n.gain.gain.value, now)
    n.gain.gain.linearRampToValueAtTime(0, now + 0.2)
    setTimeout(() => {
      n.oscA.stop()
      n.oscB.stop()
      n.lfo.stop()
      n.oscA.disconnect()
      n.oscB.disconnect()
      n.lfo.disconnect()
      n.lfoGain.disconnect()
      n.gain.disconnect()
    }, 260)
  }
}
