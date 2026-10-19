import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  delete process.env.ANTHROPIC_WORKSPACE_ID
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('SettingsService', () => {
  it('prefers the .env key over a stale inherited environment variable', () => {
    process.env.ANTHROPIC_API_KEY = 'stale-system-key'
    writeFileSync(env, 'ANTHROPIC_API_KEY=fresh-env-key')
    expect(new SettingsService(dir, env).keysFor('anthropic')).toEqual(['fresh-env-key'])
  })

  it('converts a rate saved as a multiplier by older builds into the offset the slider uses', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ voice: { engine: 'edge', voice: 'en-US-AvaNeural', rate: 1.2, pitch: 0 } }))
    expect(new SettingsService(dir, env).get().voice.rate).toBeCloseTo(0.2)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ voice: { engine: 'edge', voice: 'en-US-AvaNeural', rate: 0.15, pitch: 0 } }))
    expect(new SettingsService(dir, env).get().voice.rate).toBe(0.15)
  })

  it('reads GROQ_KEYS in the pool format [{ key, label, proxy }]', () => {
    writeFileSync(env, `GROQ_KEYS=[{"key":"gsk_a","label":"a","proxy":"http://p"},{"key":"gsk_b"},"gsk_c"]`)
    expect(new SettingsService(dir, env).keysFor('groq')).toEqual(['gsk_a', 'gsk_b', 'gsk_c'])
  })

  it('sends the Anthropic workspace id from .env as a header', () => {
    writeFileSync(env, 'ANTHROPIC_WORKSPACE_ID=wrkspc_1')
    const s = new SettingsService(dir, env)
    expect(s.headersFor('anthropic')).toEqual({ 'anthropic-workspace-id': 'wrkspc_1' })
    expect(s.headersFor('groq')).toBeUndefined()
  })

  it('starts from defaults and deep-merges patches, persisting them', () => {
    const s = new SettingsService(dir, env)
    expect(s.get()).toEqual(DEFAULT_SETTINGS)
    const seen: string[] = []
    s.onChange((n) => seen.push(n.voice.voice))
    s.set({ voice: { ...s.get().voice, voice: 'en-GB-SoniaNeural' }, endpoint: { ...s.get().endpoint, duckGain: 0.1 } })
    expect(s.get().voice).toMatchObject({ voice: 'en-GB-SoniaNeural', rate: 0 })
    expect(s.get().endpoint.duckGain).toBe(0.1)
    expect(s.get().endpoint.maxSilenceMs).toBe(DEFAULT_SETTINGS.endpoint.maxSilenceMs)
    expect(seen).toEqual(['en-GB-SoniaNeural'])
    const reloaded = new SettingsService(dir, env)
    expect(reloaded.get().voice.voice).toBe('en-GB-SoniaNeural')
  })

  it('writes only tuning values that differ from the defaults, and replaces superseded defaults at load', () => {
    const s = new SettingsService(dir, env)
    s.set({ endpoint: { ...s.get().endpoint, duckGain: 0.1 } })
    const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(written.endpoint).toEqual({ duckGain: 0.1 })
    expect(written.brain).toEqual({})
    expect(written.voice).toEqual(DEFAULT_SETTINGS.voice)

    // a file written by an older build pins the old defaults; the user's own change survives
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ endpoint: { maxSilenceMs: 1200, maxUtteranceMs: 30000, duckGain: 0.1 }, speech: { firstMinWords: 6 }, brain: { maxStepsAsk: 2, temperature: 0.3 } })
    )
    const old = new SettingsService(dir, env)
    expect(old.get().endpoint.maxSilenceMs).toBe(DEFAULT_SETTINGS.endpoint.maxSilenceMs)
    expect(old.get().endpoint.maxUtteranceMs).toBe(DEFAULT_SETTINGS.endpoint.maxUtteranceMs)
    expect(old.get().speech.firstMinWords).toBe(DEFAULT_SETTINGS.speech.firstMinWords)
    expect(old.get().brain.maxStepsAsk).toBe(DEFAULT_SETTINGS.brain.maxStepsAsk)
    expect(old.get().endpoint.duckGain).toBe(0.1)
    expect(old.get().brain.temperature).toBe(0.3)
    expect(old.migrations.map((m) => `${m.group}.${m.key}`)).toEqual(['endpoint.maxSilenceMs', 'endpoint.maxUtteranceMs', 'brain.maxStepsAsk', 'speech.firstMinWords'])
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
