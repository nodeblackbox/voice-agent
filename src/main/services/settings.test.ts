import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  }
}))

import { DEFAULT_SETTINGS, SettingsService } from './settings'

let dir: string
let env: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'va-settings-'))
  env = join(dir, '.env')
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.GROQ_KEYS
  delete process.env.GROQ_API_KEY
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('SettingsService', () => {
  it('starts from defaults and deep-merges patches, persisting them', () => {
    const s = new SettingsService(dir, env)
    expect(s.get()).toEqual(DEFAULT_SETTINGS)
    const seen: string[] = []
    s.onChange((n) => seen.push(n.voice.voice))
    s.set({ voice: { ...s.get().voice, voice: 'en-GB-SoniaNeural' }, endpoint: { ...s.get().endpoint, duckGain: 0.1 } })
    expect(s.get().voice).toMatchObject({ voice: 'en-GB-SoniaNeural', rate: 1 })
    expect(s.get().endpoint.duckGain).toBe(0.1)
    expect(s.get().endpoint.maxSilenceMs).toBe(DEFAULT_SETTINGS.endpoint.maxSilenceMs)
    expect(seen).toEqual(['en-GB-SoniaNeural'])
    const reloaded = new SettingsService(dir, env)
    expect(reloaded.get().voice.voice).toBe('en-GB-SoniaNeural')
  })

  it('reads keys from a .env file, including JSON key lists', () => {
    writeFileSync(env, `# comment\nANTHROPIC_API_KEY="sk-ant-123"\nGROQ_KEYS=["g1", "g2"]\n`)
    const s = new SettingsService(dir, env)
    expect(s.keysFor('anthropic')).toEqual(['sk-ant-123'])
    expect(s.keysFor('groq')).toEqual(['g1', 'g2'])
    expect(s.keysFor('xai')).toEqual([])
    expect(s.keyStatus().find((k) => k.provider === 'groq')).toMatchObject({ set: true, hint: expect.stringContaining('(+1)') })
  })

  it('stores keys encrypted and prefers them over the environment', () => {
    writeFileSync(env, 'ANTHROPIC_API_KEY=from-env\n')
    const s = new SettingsService(dir, env)
    s.setKey('anthropic', ' sk-stored ')
    expect(s.keysFor('anthropic')).toEqual(['sk-stored'])
    const again = new SettingsService(dir, env)
    expect(again.keysFor('anthropic')).toEqual(['sk-stored'])
    again.setKey('anthropic', '')
    expect(again.keysFor('anthropic')).toEqual(['from-env'])
  })

  it('manages custom styles and resets the active style when it is deleted', () => {
    const s = new SettingsService(dir, env)
    const style = { id: 'mentor', label: 'Mentor', desc: 'd', kind: 'built-in' as const, body: 'b', length: 'short' as const, format: 'plain' as const }
    expect(s.saveStyle(style)[0]?.kind).toBe('custom')
    s.set({ styleId: 'mentor' })
    s.deleteStyle('mentor')
    expect(s.styles()).toEqual([])
    expect(s.get().styleId).toBe(DEFAULT_SETTINGS.styleId)
  })

  it('merges stored skills over the built-ins and persists them', () => {
    const s = new SettingsService(dir, env)
    const first = s.skills()[0]!
    s.saveSkill({ ...first, enabled: false })
    s.saveSkill({ id: 'c1', name: 'Custom', trigger: 'When', procedure: 'Do', enabled: true, kind: 'custom' })
    const again = new SettingsService(dir, env)
    expect(again.skills()[0]).toMatchObject({ id: first.id, enabled: false })
    expect(again.skills().at(-1)).toMatchObject({ id: 'c1', kind: 'custom' })
    again.deleteSkill('c1')
    expect(again.skills().some((k) => k.id === 'c1')).toBe(false)
  })
})
