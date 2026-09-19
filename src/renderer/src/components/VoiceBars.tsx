import { useEffect, useRef } from 'react'
import { capture } from '../audio/capture'
import { playback } from '../audio/playback'
import { Bars } from './primitives'

/**
 * Bars that move with the actual audio: the microphone while listening, the voice while speaking.
 * Each bar is one frequency band of the voice range, so speech makes them dance rather than
 * breathe on a timer. Falls back to the timed wave when there is no audio graph to read yet.
 */
export function VoiceBars({ source, color, h = 14, n = 5 }: { source: 'mic' | 'output'; color: string; h?: number; n?: number }) {
  const refs = useRef<Array<HTMLSpanElement | null>>([])
  const hasGraph = source === 'mic' ? capture.analyser !== null : playback.currentAnalyser() !== null

  useEffect(() => {
    if (!hasGraph) return
    let raf = 0
    let buf: Uint8Array<ArrayBuffer> | null = null
    const levels = new Array<number>(n).fill(0)
    const MIN = 0.18
    const tick = (t: number): void => {
      const an = source === 'mic' ? capture.analyser : playback.currentAnalyser()
      if (an) {
        if (!buf || buf.length !== an.frequencyBinCount) buf = new Uint8Array(an.frequencyBinCount)
        an.getByteFrequencyData(buf)
        const hz = an.context.sampleRate / an.fftSize
        // log-spaced bands across the voice range, 100 Hz - 4 kHz
        const lo = 100
        const hi = Math.min(4000, an.context.sampleRate / 2)
        for (let i = 0; i < n; i++) {
          const f0 = lo * Math.pow(hi / lo, i / n)
          const f1 = lo * Math.pow(hi / lo, (i + 1) / n)
          const b0 = Math.max(0, Math.floor(f0 / hz))
          const b1 = Math.min(buf.length - 1, Math.max(b0, Math.ceil(f1 / hz)))
          let peak = 0
          for (let b = b0; b <= b1; b++) if (buf[b]! > peak) peak = buf[b]!
          const target = Math.min(1, Math.pow(peak / 255, 1.4) * 1.3)
          const cur = levels[i]!
          levels[i] = cur + (target - cur) * (target > cur ? 0.55 : 0.18)
        }
      }
      for (let i = 0; i < n; i++) {
        const el = refs.current[i]
        if (!el) continue
        // a faint idle breath so silence does not look dead
        const idle = MIN + 0.05 * (0.5 + 0.5 * Math.sin(t / 420 + i * 0.9))
        const scale = Math.max(idle, MIN + (1 - MIN) * levels[i]!)
        el.style.transform = `scaleY(${scale.toFixed(3)})`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [source, n, hasGraph])

  if (!hasGraph) return <Bars color={color} h={h} n={n} />
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, height: h }}>
      {Array.from({ length: n }).map((_, i) => (
        <span
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          style={{ width: 3, height: h, borderRadius: 2, background: color, display: 'inline-block', transformOrigin: 'center', transform: 'scaleY(0.18)', willChange: 'transform' }}
        />
      ))}
    </span>
  )
}
