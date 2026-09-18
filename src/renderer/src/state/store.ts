import { create } from 'zustand'
import type {
  AgentEvent,
  AgentState,
  ChatMessage,
  ContextSnapshot,
  KeyStatus,
  ModelInfo,
  PendingMemorySave,
  Project,
  PromptStyle,
  ServiceName,
  ServiceStatus,
  Session,
  Settings,
  Skill,
  Toast,
  TurnMetrics
} from '@shared/types'
import { playback } from '../audio/playback'
import { cue } from '../audio/cue'
import { listDevices, pickDefaults } from '../audio/devices'
import { rlog } from '../lib/rlog'

export type View = 'chat' | 'prompts' | 'skills' | 'memory' | 'projects' | 'diagnostics' | 'settings'

const MUTED_KEY = 'va.muted'
const LEFT_KEY = 'va.leftOpen'
const RIGHT_KEY = 'va.rightOpen'

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function writeBool(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0')
  } catch {
    // storage unavailable
  }
}

interface Store {
  ready: boolean
  view: View
  leftOpen: boolean
  rightOpen: boolean
  settings: Settings | null
  models: ModelInfo[]
  styles: PromptStyle[]
  skills: Skill[]
  projects: Project[]
  sessions: Session[]
  activeSessionId: string | null
  messages: ChatMessage[]
  agentState: AgentState
  services: Partial<Record<ServiceName, ServiceStatus>>
  partial: string
  level: number
  cueOn: boolean
  duckGain: number
  pendingSave: PendingMemorySave | null
  toasts: Toast[]
  context: ContextSnapshot | null
  keys: KeyStatus[]
  lastMetrics: TurnMetrics | null
  listening: boolean
  muted: boolean
  memoryVersion: number
  mcpVersion: number

  init(): Promise<void>
  setView(v: View): void
  setLeftOpen(v: boolean): void
  setRightOpen(v: boolean): void
  updateSettings(patch: Partial<Settings>): Promise<void>
  reloadStyles(): Promise<void>
  reloadSkills(): Promise<void>
  reloadProjects(): Promise<void>
  reloadSessions(): Promise<void>
  reloadKeys(): Promise<void>
  reloadServices(): Promise<void>
  reloadContext(): Promise<void>
  selectSession(id: string): Promise<void>
  newSession(): Promise<void>
  deleteSession(id: string): Promise<void>
  dismissToast(id: string): void
  pushToast(kind: Toast['kind'], text: string): void
  setListening(v: boolean): void
  setMuted(v: boolean): void
}

let initialised = false

export const useStore = create<Store>((set, get) => ({
  ready: false,
  view: 'chat',
  leftOpen: readBool(LEFT_KEY, true),
  rightOpen: readBool(RIGHT_KEY, false),
  settings: null,
  models: [],
  styles: [],
  skills: [],
  projects: [],
  sessions: [],
  activeSessionId: null,
  messages: [],
  agentState: 'idle',
  services: {},
  partial: '',
  level: 0,
  cueOn: false,
  duckGain: 1,
  pendingSave: null,
  toasts: [],
  context: null,
  keys: [],
  lastMetrics: null,
  listening: false,
  muted: readBool(MUTED_KEY, false),
  memoryVersion: 0,
  mcpVersion: 0,

  async init() {
    if (initialised) return
    initialised = true
    playback.subscribe()
    playback.setMuted(get().muted)

    window.api.onEvent((e: AgentEvent) => {
      switch (e.type) {
        case 'state':
          set({ agentState: e.state, partial: e.state === 'user_speaking' ? get().partial : '' })
          break
        case 'service':
          set({ services: { ...get().services, [e.status.name]: e.status } })
          break
        case 'message': {
          const msgs = get().messages
          const idx = msgs.findIndex((m) => m.id === e.message.id)
          if (idx >= 0) {
            const next = msgs.slice()
            next[idx] = e.message
            set({ messages: next })
          } else if (!get().activeSessionId || e.message.sessionId === get().activeSessionId) {
            const next = [...msgs, e.message].sort((a, b) => a.createdAt - b.createdAt)
            set({ messages: next, activeSessionId: get().activeSessionId ?? e.message.sessionId })
          }
          break
        }
        case 'message-removed':
          set({ messages: get().messages.filter((m) => m.id !== e.id) })
          break
        case 'partial':
          set({ partial: e.text })
          break
        case 'level':
          set({ level: e.p })
          break
        case 'metrics': {
          set({ lastMetrics: e.metrics })
          const msgs = get().messages
          const idx = msgs.findIndex((m) => m.turnId === e.turnId && m.role === 'assistant')
          if (idx >= 0) {
            const next = msgs.slice()
            const m = next[idx]
            if (m) next[idx] = { ...m, metrics: e.metrics }
            set({ messages: next })
          }
          break
        }
        case 'duck':
          set({ duckGain: e.gain })
          playback.setDuck(e.gain)
          break
        case 'cue':
          set({ cueOn: e.on })
          if (e.on && get().settings?.behaviour.loadingSound !== false) cue.start()
          else cue.stop()
          break
        case 'memory-confirm':
          set({ pendingSave: e.pending })
          break
        case 'memory-changed':
          set({ memoryVersion: get().memoryVersion + 1 })
          void get().reloadContext()
          break
        case 'sessions-changed':
          void get().reloadSessions()
          break
        case 'settings-changed':
          set({ settings: e.settings })
          playback.configure(e.settings.playback)
          void playback.setOutput(e.settings.audio.outputDeviceId)
          break
        case 'toast':
          get().pushToast(e.toast.kind, e.toast.text)
          break
        case 'context':
          set({ context: e.snapshot })
          break
        case 'skills-changed':
          void get().reloadSkills()
          void get().reloadContext()
          break
        case 'mcp-changed':
          set({ mcpVersion: get().mcpVersion + 1 })
          void get().reloadServices()
          void get().reloadContext()
          break
      }
    })

    const [settings, models, styles, projects, sessions, services, keys, history, context, skills] = await Promise.all([
      window.api.settings.get(),
      window.api.models.list(),
      window.api.styles.list(),
      window.api.projects.list(),
      window.api.sessions.list(),
      window.api.services.status(),
      window.api.keys.status(),
      window.api.chat.history(),
      window.api.context.snapshot().catch(() => null),
      window.api.skills.list().catch(() => [] as Skill[])
    ])
    const svc: Partial<Record<ServiceName, ServiceStatus>> = {}
    for (const s of services) svc[s.name] = s
    const sorted = sessions.slice().sort((a, b) => b.createdAt - a.createdAt)
    const activeSessionId = history[0]?.sessionId ?? sorted[0]?.id ?? null
    set({
      settings,
      models,
      styles,
      skills,
      projects,
      sessions: sorted,
      services: svc,
      keys,
      messages: history,
      activeSessionId,
      context,
      ready: true
    })
    playback.configure(settings.playback)
    void playback.setOutput(settings.audio.outputDeviceId)

    try {
      const devices = await listDevices()
      const patch = pickDefaults(settings.audio, devices)
      if (patch) await get().updateSettings({ audio: { ...settings.audio, ...patch } })
    } catch (e) {
      rlog('info', 'devices', `no device access yet (${e instanceof Error ? e.message : String(e)}); the settings page retries`)
    }
  },

  setView: (view) => set({ view }),
  setLeftOpen: (v) => {
    writeBool(LEFT_KEY, v)
    set({ leftOpen: v })
  },
  setRightOpen: (v) => {
    writeBool(RIGHT_KEY, v)
    set({ rightOpen: v })
  },

  async updateSettings(patch) {
    const settings = await window.api.settings.set(patch)
    set({ settings })
    if (patch.playback) playback.configure(settings.playback)
    if (patch.audio) void playback.setOutput(settings.audio.outputDeviceId)
  },

  async reloadStyles() {
    set({ styles: await window.api.styles.list() })
  },
  async reloadSkills() {
    try {
      set({ skills: await window.api.skills.list() })
    } catch {
      // skills unavailable
    }
  },
  async reloadProjects() {
    set({ projects: await window.api.projects.list() })
  },
  async reloadSessions() {
    const sessions = await window.api.sessions.list()
    set({ sessions: sessions.slice().sort((a, b) => b.createdAt - a.createdAt) })
  },
  async reloadKeys() {
    set({ keys: await window.api.keys.status() })
  },
  async reloadServices() {
    const services = await window.api.services.status()
    const svc: Partial<Record<ServiceName, ServiceStatus>> = {}
    for (const s of services) svc[s.name] = s
    set({ services: svc })
  },
  async reloadContext() {
    try {
      set({ context: await window.api.context.snapshot() })
    } catch {
      // context not available yet
    }
  },

  async selectSession(id) {
    const messages = await window.api.sessions.select(id)
    set({ activeSessionId: id, messages, partial: '' })
  },
  async newSession() {
    const s = await window.api.sessions.new()
    await get().reloadSessions()
    set({ activeSessionId: s.id, messages: [], partial: '' })
  },
  async deleteSession(id) {
    const sessions = await window.api.sessions.delete(id)
    const sorted = sessions.slice().sort((a, b) => b.createdAt - a.createdAt)
    set({ sessions: sorted })
    if (get().activeSessionId === id) {
      const next = sorted[0]
      if (next) await get().selectSession(next.id)
      else await get().newSession()
    }
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  pushToast: (kind, text) => {
    const toast: Toast = { id: crypto.randomUUID(), kind, text }
    rlog(kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info', 'toast', text)
    set({ toasts: [...get().toasts, toast] })
    setTimeout(() => get().dismissToast(toast.id), kind === 'error' ? 9000 : 6000)
  },

  setListening: (v) => set({ listening: v }),
  setMuted: (v) => {
    writeBool(MUTED_KEY, v)
    playback.setMuted(v)
    set({ muted: v })
  }
}))

export const selectActiveProject = (s: Store): Project | undefined =>
  s.projects.find((p) => p.id === s.settings?.projectId)

export const selectActiveStyle = (s: Store): PromptStyle | undefined =>
  s.styles.find((p) => p.id === s.settings?.styleId)

export const selectActiveModel = (s: Store): ModelInfo | undefined =>
  s.models.find((m) => m.id === s.settings?.modelId)

export const selectActiveSession = (s: Store): Session | undefined =>
  s.sessions.find((x) => x.id === s.activeSessionId)
