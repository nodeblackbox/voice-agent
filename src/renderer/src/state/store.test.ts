import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, ChatMessage, Settings } from '@shared/types'

vi.mock('../audio/playback', () => ({
  playback: { subscribe: vi.fn(), setMuted: vi.fn(), setDuck: vi.fn(), configure: vi.fn(), setOutput: vi.fn().mockResolvedValue(undefined), cancel: vi.fn(), onSpeaking: vi.fn(), onChunk: vi.fn(), playing: false }
}))
vi.mock('../audio/cue', () => ({ cue: { start: vi.fn(), stop: vi.fn() } }))
vi.mock('../audio/devices', () => ({ listDevices: vi.fn().mockRejectedValue(new Error('no devices')), pickDefaults: vi.fn() }))

const settings = {
  modelId: 'anthropic:claude-haiku-4-5',
  fallbackModelId: 'groq:x',
  mode: 'ask',
  styleId: 'short',
  projectId: 'global',
  agentName: 'Ava',
  userName: 'me',
  voice: { engine: 'edge', voice: 'en-US-AvaNeural', rate: 1, pitch: 0 },
  audio: {},
  behaviour: { confirmBeforeSave: false, fillerBeforeTools: true, loadingSound: true, speakTypedReplies: true, listenOnLaunch: false },
  location: { mode: 'off', manual: '' },
  searxng: { url: 'http://127.0.0.1:8888', autostart: false },
  mcp: { enabled: true },
  stt: { model: 'm', device: 'cpu', pythonPath: '' },
  endpoint: {} as Settings['endpoint']
} as Settings

let handler: ((e: AgentEvent) => void) | null = null
const api = {
  onEvent: vi.fn((h: (e: AgentEvent) => void) => {
    handler = h
    return () => undefined
  }),
  onAudioChunk: vi.fn(() => () => undefined),
  onAudioCancel: vi.fn(() => () => undefined),
  settings: { get: vi.fn().mockResolvedValue(settings), set: vi.fn(async (p: Partial<Settings>) => ({ ...settings, ...p })) },
  models: { list: vi.fn().mockResolvedValue([]) },
  styles: { list: vi.fn().mockResolvedValue([]) },
  skills: { list: vi.fn().mockResolvedValue([{ id: 's1', name: 'Web research', trigger: 't', procedure: 'p', enabled: true, kind: 'built-in' }]) },
  projects: { list: vi.fn().mockResolvedValue([]) },
  sessions: { list: vi.fn().mockResolvedValue([{ id: 'sess-1', title: 'New session', projectId: 'global', createdAt: 1, messageCount: 0 }]), new: vi.fn(), select: vi.fn(), delete: vi.fn() },
  services: { status: vi.fn().mockResolvedValue([{ name: 'mcp', state: 'ready' }]) },
  keys: { status: vi.fn().mockResolvedValue([]) },
  chat: { history: vi.fn().mockResolvedValue([]) },
  context: { snapshot: vi.fn().mockResolvedValue({ now: 'n', timezone: 'tz', location: 'l', project: 'p', style: 's', memoryEntries: 0, skills: [], tools: [] }) }
}
Object.defineProperty(globalThis, 'window', { value: Object.assign(globalThis.window ?? {}, { api }), writable: true, configurable: true })
;(globalThis as { window: { api: unknown } }).window.api = api

const { useStore } = await import('./store')

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: over.id ?? crypto.randomUUID(),
  turnId: over.turnId ?? 't1',
  sessionId: over.sessionId ?? 'sess-1',
  role: over.role ?? 'user',
  text: over.text ?? 'hi',
  createdAt: over.createdAt ?? 1000,
  ...over
})

const emit = (e: AgentEvent) => {
  if (!handler) throw new Error('store did not subscribe')
  handler(e)
}

describe('store event reducer', () => {
  beforeEach(async () => {
    await useStore.getState().init()
    useStore.setState({ messages: [], toasts: [], pendingSave: null, cueOn: false, duckGain: 1, partial: '' })
    vi.clearAllMocks()
  })

  it('subscribes once and loads initial data including skills', () => {
    expect(handler).not.toBeNull()
    const s = useStore.getState()
    expect(s.ready).toBe(true)
    expect(s.skills).toHaveLength(1)
    expect(s.activeSessionId).toBe('sess-1')
  })

  it('appends messages in createdAt order and upserts by id', () => {
    emit({ type: 'message', message: msg({ id: 'a', role: 'assistant', text: 'reply', createdAt: 2000 }) })
    emit({ type: 'message', message: msg({ id: 'tool', role: 'tool', text: 'web_search', createdAt: 1999 }) })
    emit({ type: 'message', message: msg({ id: 'u', role: 'user', text: 'q', createdAt: 1000 }) })
    expect(useStore.getState().messages.map((m) => m.id)).toEqual(['u', 'tool', 'a'])
    emit({ type: 'message', message: msg({ id: 'a', role: 'assistant', text: 'reply, longer', createdAt: 2000 }) })
    const msgs = useStore.getState().messages
    expect(msgs).toHaveLength(3)
    expect(msgs[2]?.text).toBe('reply, longer')
  })

  it('ignores messages from another session', () => {
    emit({ type: 'message', message: msg({ id: 'x', sessionId: 'other' }) })
    expect(useStore.getState().messages).toHaveLength(0)
  })

  it('tracks agent state and clears the partial caption outside user_speaking', () => {
    emit({ type: 'state', state: 'user_speaking' })
    emit({ type: 'partial', text: 'hel' })
    expect(useStore.getState().partial).toBe('hel')
    emit({ type: 'state', state: 'thinking' })
    expect(useStore.getState().agentState).toBe('thinking')
    expect(useStore.getState().partial).toBe('')
  })

  it('records service status by name', () => {
    emit({ type: 'service', status: { name: 'sidecar', state: 'ready', detail: 'ok' } })
    expect(useStore.getState().services.sidecar?.detail).toBe('ok')
  })

  it('applies duck and cue events to audio', async () => {
    const { playback } = await import('../audio/playback')
    const { cue } = await import('../audio/cue')
    emit({ type: 'duck', gain: 0.25 })
    expect(useStore.getState().duckGain).toBe(0.25)
    expect(playback.setDuck).toHaveBeenCalledWith(0.25)
    emit({ type: 'cue', on: true })
    expect(cue.start).toHaveBeenCalled()
    emit({ type: 'cue', on: false })
    expect(cue.stop).toHaveBeenCalled()
  })

  it('stores and clears the pending memory confirmation', () => {
    const pending = { id: 'p1', key: 'Gym', value: 'E&C', kind: 'profile' as const, tags: [] }
    emit({ type: 'memory-confirm', pending })
    expect(useStore.getState().pendingSave?.key).toBe('Gym')
    emit({ type: 'memory-confirm', pending: null })
    expect(useStore.getState().pendingSave).toBeNull()
  })

  it('attaches metrics to the assistant message of that turn', () => {
    emit({ type: 'message', message: msg({ id: 'a', role: 'assistant', turnId: 't9', text: 'r', createdAt: 5 }) })
    emit({ type: 'metrics', turnId: 't9', metrics: { ttfaMs: 420, inputTokens: 10, outputTokens: 5 } })
    expect(useStore.getState().messages[0]?.metrics?.inputTokens).toBe(10)
    expect(useStore.getState().lastMetrics?.ttfaMs).toBe(420)
  })

  it('reloads sessions, skills and services on change events', async () => {
    emit({ type: 'sessions-changed' })
    emit({ type: 'skills-changed' })
    emit({ type: 'mcp-changed' })
    await Promise.resolve()
    await Promise.resolve()
    expect(api.sessions.list).toHaveBeenCalled()
    expect(api.skills.list).toHaveBeenCalled()
    expect(api.services.status).toHaveBeenCalled()
    expect(useStore.getState().mcpVersion).toBeGreaterThan(0)
  })

  it('pushes toasts and bumps memoryVersion', () => {
    emit({ type: 'toast', toast: { id: 'x', kind: 'warn', text: 'careful' } })
    expect(useStore.getState().toasts[0]?.text).toBe('careful')
    const before = useStore.getState().memoryVersion
    emit({ type: 'memory-changed' })
    expect(useStore.getState().memoryVersion).toBe(before + 1)
  })

  it('applies settings-changed', () => {
    emit({ type: 'settings-changed', settings: { ...settings, mode: 'agent' } })
    expect(useStore.getState().settings?.mode).toBe('agent')
  })
})
