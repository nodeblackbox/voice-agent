import { capture } from './capture'
import { useStore } from '../state/store'

let busy = false

export async function startListening(): Promise<void> {
  if (busy || useStore.getState().listening) return
  busy = true
  try {
    const deviceId = useStore.getState().settings?.audio.inputDeviceId
    await capture.start(deviceId)
    await window.api.voice.start()
    useStore.getState().setListening(true)
  } catch (err) {
    await capture.stop()
    useStore.getState().pushToast('error', `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    busy = false
  }
}

export async function stopListening(): Promise<void> {
  if (busy) return
  busy = true
  try {
    await window.api.voice.stop().catch(() => undefined)
    await capture.stop()
    useStore.getState().setListening(false)
  } finally {
    busy = false
  }
}

export function toggleListening(): Promise<void> {
  return useStore.getState().listening ? stopListening() : startListening()
}
