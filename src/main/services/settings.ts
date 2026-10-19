import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { KeyStatus, PromptStyle, Provider, Settings, Skill } from '@shared/types'
import { defaultTuning, sanitizeTuning, stripTuningDefaults, type TuningMigration } from '@shared/tuning'
import { DEFAULT_FALLBACK_MODEL_ID, DEFAULT_MODEL_ID } from '@core/providers/models'
import { DEFAULT_STYLE_ID } from '@core/prompts/styles'
import { mergeSkills } from '@core/prompts/skills'
import type { KeySource } from '@core/providers/keys'
import { log } from './log'

export const DEFAULT_SETTINGS: Settings = {
  modelId: DEFAULT_MODEL_ID,
  fallbackModelId: DEFAULT_FALLBACK_MODEL_ID,
  mode: 'ask',
  styleId: DEFAULT_STYLE_ID,
  projectId: 'global',
  agentName: 'Ava',
  userName: 'the user',
  aboutUser: '',
  voice: { engine: 'edge', voice: 'en-US-AvaNeural', kokoroVoice: 'af_heart', rate: 1.0, pitch: 0 },
  audio: {},
  ...defaultTuning(),
  stt: { model: 'nemo-parakeet-tdt-0.6b-v2', device: 'hybrid', pythonPath: '' },
  behaviour: { confirmBeforeSave: false, fillerBeforeTools: true, loadingSound: true, speakTypedReplies: true, listenOnLaunch: false },
  location: { mode: 'manual', manual: '' },
  searxng: { url: 'http://127.0.0.1:8888', autostart: false },
  mcp: { enabled: true }
}

const ENV_KEYS: Record<Provider, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  groq: ['GROQ_KEYS', 'GROQ_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  xai: ['XAI_API_KEY', 'GROK_API_KEY']
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch ?? {})) {
    const cur = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
    } else if (v !== undefined) out[k] = v
  }
  return out as T
}

function parseDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    out[key] = val
  }
  return out
}

export class SettingsService implements KeySource {
  private settings: Settings
  private keys: Partial<Record<Provider, string[]>> = {}
  private customStyles: PromptStyle[] = []
  private storedSkills: Skill[] = []
  private readonly settingsPath: string
  private readonly keysPath: string
  private readonly stylesPath: string
  private readonly skillsPath: string
  private env: Record<string, string>
  private listeners = new Set<(s: Settings) => void>()
  /** Superseded tuning defaults replaced at load (empty after the first save rewrites the file). */
  readonly migrations: TuningMigration[]

  constructor(
    private readonly userData: string,
    dotEnvPath: string
  ) {
    mkdirSync(userData, { recursive: true })
    this.settingsPath = join(userData, 'settings.json')
    this.keysPath = join(userData, 'keys.json')
    this.stylesPath = join(userData, 'styles.json')
    this.skillsPath = join(userData, 'skills.json')
    this.env = { ...parseDotEnv(dotEnvPath), ...process.env } as Record<string, string>
    const stored = this.readJson<Partial<Settings>>(this.settingsPath, {})
    // tuning groups: unknown keys dropped, values clamped, superseded defaults replaced by current ones
    const migrated: TuningMigration[] = []
    const tuning = sanitizeTuning(stored, (m) => migrated.push(m))
    this.settings = deepMerge(DEFAULT_SETTINGS, { ...stored, ...tuning })
    this.migrations = migrated
    this.customStyles = this.readJson<PromptStyle[]>(this.stylesPath, [])
    this.storedSkills = this.readJson<Skill[]>(this.skillsPath, [])
    this.loadKeys()
  }

  private readJson<T>(path: string, fallback: T): T {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback
    } catch (e) {
      log('settings', `could not read ${path}: ${(e as Error).message}`)
      return fallback
    }
  }

  // ---- settings ---------------------------------------------------------------------------
  get(): Settings {
    return this.settings
  }

  set(patch: Partial<Settings>): Settings {
    this.settings = deepMerge(this.settings, patch)
    this.persist()
    for (const fn of this.listeners) fn(this.settings)
    return this.settings
  }

  /** Tuning values equal to their default are not written, so a future default change reaches this file. */
  private persist(): void {
    writeFileSync(this.settingsPath, JSON.stringify(stripTuningDefaults(this.settings), null, 2))
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ---- styles -----------------------------------------------------------------------------
  styles(): PromptStyle[] {
    return this.customStyles
  }

  saveStyle(style: PromptStyle): PromptStyle[] {
    const idx = this.customStyles.findIndex((s) => s.id === style.id)
    const custom: PromptStyle = { ...style, kind: 'custom' }
    if (idx >= 0) this.customStyles[idx] = custom
    else this.customStyles.push(custom)
    writeFileSync(this.stylesPath, JSON.stringify(this.customStyles, null, 2))
    return this.customStyles
  }

  deleteStyle(id: string): PromptStyle[] {
    this.customStyles = this.customStyles.filter((s) => s.id !== id)
    writeFileSync(this.stylesPath, JSON.stringify(this.customStyles, null, 2))
    if (this.settings.styleId === id) this.set({ styleId: DEFAULT_STYLE_ID })
    return this.customStyles
  }

  // ---- skills -----------------------------------------------------------------------------
  skills(): Skill[] {
    return mergeSkills(this.storedSkills)
  }

  saveSkill(skill: Skill): Skill[] {
    const idx = this.storedSkills.findIndex((s) => s.id === skill.id)
    if (idx >= 0) this.storedSkills[idx] = skill
    else this.storedSkills.push(skill)
    writeFileSync(this.skillsPath, JSON.stringify(this.storedSkills, null, 2))
    return this.skills()
  }

  deleteSkill(id: string): Skill[] {
    this.storedSkills = this.storedSkills.filter((s) => s.id !== id)
    writeFileSync(this.skillsPath, JSON.stringify(this.storedSkills, null, 2))
    return this.skills()
  }

  // ---- keys -------------------------------------------------------------------------------
  private loadKeys(): void {
    const stored = this.readJson<Partial<Record<Provider, string>>>(this.keysPath, {})
    for (const [provider, enc] of Object.entries(stored) as Array<[Provider, string]>) {
      try {
        const plain = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : Buffer.from(enc, 'base64').toString('utf8')
        this.keys[provider] = this.split(plain)
      } catch (e) {
        log('settings', `could not decrypt key for ${provider}: ${(e as Error).message}`)
      }
    }
  }

  private split(raw: string): string[] {
    const trimmed = raw.trim()
    if (trimmed.startsWith('[')) {
      try {
        return (JSON.parse(trimmed) as string[]).map((s) => s.trim()).filter(Boolean)
      } catch {
        // fall through to comma splitting
      }
    }
    return trimmed
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  keysFor(provider: Provider): string[] {
    const stored = this.keys[provider]
    if (stored?.length) return stored
    for (const name of ENV_KEYS[provider]) {
      const v = this.env[name]
      if (v) return this.split(v)
    }
    return []
  }

  headersFor(provider: Provider): Record<string, string> | undefined {
    if (provider !== 'anthropic') return undefined
    const ws = this.env.ANTHROPIC_WORKSPACE_ID?.trim()
    return ws ? { 'anthropic-workspace-id': ws } : undefined
  }

  setKey(provider: Provider, raw: string): KeyStatus[] {
    const keys = this.split(raw)
    const stored = this.readJson<Partial<Record<Provider, string>>>(this.keysPath, {})
    if (!keys.length) {
      delete stored[provider]
      delete this.keys[provider]
    } else {
      const plain = JSON.stringify(keys)
      stored[provider] = (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain) : Buffer.from(plain, 'utf8')).toString('base64')
      this.keys[provider] = keys
    }
    writeFileSync(this.keysPath, JSON.stringify(stored, null, 2))
    return this.keyStatus()
  }

  keyStatus(): KeyStatus[] {
    return (Object.keys(ENV_KEYS) as Provider[]).map((provider) => {
      const keys = this.keysFor(provider)
      const first = keys[0]
      return {
        provider,
        set: keys.length > 0,
        hint: first ? `${first.slice(0, 6)}…${first.slice(-4)}${keys.length > 1 ? ` (+${keys.length - 1})` : ''}` : undefined
      }
    })
  }

  get dataDir(): string {
    return this.userData
  }
}
