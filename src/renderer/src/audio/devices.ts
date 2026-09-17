import type { AudioDeviceSettings } from '@shared/types'

export interface DeviceLists {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
}

let permissionAsked = false

export async function listDevices(): Promise<DeviceLists> {
  if (!permissionAsked) {
    permissionAsked = true
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
    } catch {
      // labels stay empty without permission; selection still works by id
    }
  }
  const all = await navigator.mediaDevices.enumerateDevices()
  return {
    inputs: all.filter((d) => d.kind === 'audioinput'),
    outputs: all.filter((d) => d.kind === 'audiooutput')
  }
}

const YETI = /yeti/i

export function pickDefaults(current: AudioDeviceSettings, devices: DeviceLists): Partial<AudioDeviceSettings> | null {
  const patch: Partial<AudioDeviceSettings> = {}
  const inputStillPresent = current.inputDeviceId && devices.inputs.some((d) => d.deviceId === current.inputDeviceId)
  if (!inputStillPresent) {
    const byLabel = current.inputLabel ? devices.inputs.find((d) => d.label === current.inputLabel) : undefined
    const yeti = devices.inputs.find((d) => YETI.test(d.label) && d.deviceId !== 'default' && d.deviceId !== 'communications')
    const pick = byLabel ?? yeti
    if (pick) {
      patch.inputDeviceId = pick.deviceId
      patch.inputLabel = pick.label
    } else if (current.inputDeviceId) {
      patch.inputDeviceId = undefined
      patch.inputLabel = undefined
    }
  }
  const outputStillPresent = current.outputDeviceId && devices.outputs.some((d) => d.deviceId === current.outputDeviceId)
  if (!outputStillPresent && current.outputDeviceId) {
    const byLabel = current.outputLabel ? devices.outputs.find((d) => d.label === current.outputLabel) : undefined
    patch.outputDeviceId = byLabel?.deviceId
    patch.outputLabel = byLabel?.label
  }
  return Object.keys(patch).length ? patch : null
}
