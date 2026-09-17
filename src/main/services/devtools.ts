import { readFileSync } from 'node:fs'
import type { Agent } from '@core/agent'
import type { SidecarService } from './sidecar'
import { log } from './log'

// Dev-only: replay a 16 kHz mono PCM wav through the ears as if it came from the mic, and
// optionally inject a second wav once the agent starts speaking, to exercise barge-in.
export function replayWav(opts: { wav: string; bargeInWav?: string; sidecar: SidecarService; agent: Agent; onState: (fn: (s: string) => void) => void }): void {
  const pcm = (path: string): Buffer => {
    const buf = readFileSync(path)
    const dataIdx = buf.indexOf('data', 12, 'ascii')
    return dataIdx >= 0 ? buf.subarray(dataIdx + 8) : buf.subarray(44)
  }
  const stream = (buf: Buffer, label: string): Promise<void> =>
    new Promise((resolve) => {
      const frame = 1024
      let pos = 0
      const t0 = Date.now()
      let n = 0
      const tick = (): void => {
        while (pos < buf.length && Date.now() - t0 >= n * 32) {
          const end = Math.min(pos + frame, buf.length)
          const slice = new Uint8Array(buf.subarray(pos, end))
          opts.sidecar.sendFrame(slice.buffer as ArrayBuffer)
          pos = end
          n++
        }
        if (pos < buf.length) setTimeout(tick, 8)
        else {
          log('replay', `${label}: streamed ${(buf.length / 32000).toFixed(1)}s`)
          resolve()
        }
      }
      tick()
    })
  const silence = Buffer.alloc(32000 * 2)
  let spoke = false
  opts.onState((s) => {
    if (s === 'speaking') spoke = true
  })
  opts.sidecar.setListening(true)
  opts.agent.setMic(true)
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  void (async () => {
    await wait(1500)
    log('replay', `replaying ${opts.wav}`)
    await stream(pcm(opts.wav), 'utterance')
    await stream(silence, 'tail silence')
    if (opts.bargeInWav) {
      while (!spoke) await wait(50)
      await wait(1200)
      log('replay', `barging in with ${opts.bargeInWav}`)
      await stream(pcm(opts.bargeInWav), 'barge-in')
      await stream(silence, 'tail silence')
    }
  })()
}
