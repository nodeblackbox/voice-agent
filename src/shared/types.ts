// Shared contracts between main, preload, renderer and the agent core.
// Everything crossing an IPC boundary is defined here.

export type Provider = 'anthropic' | 'groq' | 'google' | 'xai'

export interface ModelInfo {
  id: string
  provider: Provider
  providerLabel: string
  model: string
  label: string
  note?: string
  fast?: boolean
}

export type Mode = 'ask' | 'agent'

export type AgentState =
  | 'idle'
  | 'listening'
  | 'user_speaking'
  | 'thinking'
  | 'tool'
  | 'speaking'
  | 'interrupted'

export type ServiceName = 'sidecar' | 'searxng' | 'mcp' | 'tts' | 'llm'
export type ServiceState = 'off' | 'starting' | 'ready' | 'error' | 'reconnecting'

export interface ServiceStatus {
  name: ServiceName
  state: ServiceState
  detail?: string
}

export type StyleLength = 'short' | 'balanced' | 'comprehensive'
export type StyleFormat = 'plain' | 'markdown'

export interface PromptStyle {
  id: string
  label: string
  desc: string
  kind: 'built-in' | 'custom'
  body: string
  length: StyleLength
  format: StyleFormat
}

export type ToolStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface ToolSource {
  title: string
  url: string
  snippet?: string
}

export interface ToolActivity {
  name: string
  label: string
  kind: 'search' | 'read' | 'memory' | 'mcp' | 'time' | 'other'
  status: ToolStatus
  startedAt: number
  endedAt?: number
  /** One line describing what the tool is doing, e.g. the search query or the URL being read. */
  summary?: string
  /** Human-readable outcome, e.g. "6 results" or "saved". */
  detail?: string
  sources?: ToolSource[]
  server?: string
}

export interface TurnMetrics {
  asrMs?: number
  ttftMs?: number
  ttfsMs?: number
  ttfaMs?: number
  totalMs?: number
  model?: string
  inputTokens?: number
  outputTokens?: number
  steps?: number
}

export interface Skill {
  id: string
  name: string
  trigger: string
  procedure: string
  enabled: boolean
  kind: 'built-in' | 'custom'
}

export interface McpServerConfig {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
}

export interface ChatMessage {
  id: string
  turnId: string
  sessionId: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  via?: 'voice' | 'text'
  streaming?: boolean
  interrupted?: boolean
  spokenText?: string
  tool?: ToolActivity
  metrics?: TurnMetrics
  createdAt: number
}

export interface Session {
  id: string
  title: string
  projectId: string
  createdAt: number
  messageCount: number
}

export type MemoryKind = 'profile' | 'fact' | 'decision' | 'todo'

export interface MemoryEntry {
  id: number
  scopeId: string
  kind: MemoryKind
  key: string
  value: string
  tags: string[]
  source: 'user' | 'agent' | 'ui'
  createdAt: number
  updatedAt: number
}

export interface MemoryScope {
  id: string
  name: string
  count: number
}

export interface Project {
  id: string
  name: string
  path?: string
  defaultStyleId?: string
  createdAt: number
}

export interface PendingMemorySave {
  id: string
  key: string
  value: string
  kind: MemoryKind
  tags: string[]
}

export interface AudioDeviceSettings {
  inputDeviceId?: string
  inputLabel?: string
  outputDeviceId?: string
  outputLabel?: string
}

export interface EndpointSettings {
  vadThreshold: number
  minSpeechMs: number
  minSilenceMs: number
  maxSilenceMs: number
  checkEveryMs: number
  turnThreshold: number
  turnHighThreshold: number
  bargeInThreshold: number
  bargeInChunks: number
  duckChunks: number
  duckGain: number
  bargeInDecay: number
  bargeInReleaseChunks: number
  partialEveryMs: number
}

export interface SttSettings {
  model: string
  device: 'hybrid' | 'cuda' | 'cpu'
  pythonPath: string
}

export interface VoiceSettings {
  engine: 'edge' | 'system'
  voice: string
  rate: number
  pitch: number
}

export interface BehaviourSettings {
  confirmBeforeSave: boolean
  fillerBeforeTools: boolean
  loadingSound: boolean
  speakTypedReplies: boolean
  listenOnLaunch: boolean
}

export interface LocationSettings {
  mode: 'manual' | 'ip' | 'off'
  manual: string
}

export interface Settings {
  modelId: string
  fallbackModelId: string
  mode: Mode
  styleId: string
  projectId: string
  agentName: string
  userName: string
  voice: VoiceSettings
  audio: AudioDeviceSettings
  endpoint: EndpointSettings
  stt: SttSettings
  behaviour: BehaviourSettings
  location: LocationSettings
  searxng: { url: string; autostart: boolean }
  mcp: { enabled: boolean }
}

export interface KeyStatus {
  provider: Provider
  set: boolean
  hint?: string
}

export interface McpToolInfo {
  server: string
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpServerStatus {
  name: string
  enabled: boolean
  command: string
  transport: 'stdio' | 'http'
  state: ServiceState
  error?: string
  tools: McpToolInfo[]
  stderrTail: string[]
  connectedAt?: number
  calls: number
}

export interface StyleDraft {
  label: string
  desc: string
  body: string
}

export interface VoiceInfo {
  name: string
  shortName: string
  locale: string
  gender: string
}

export interface ContextSnapshot {
  now: string
  timezone: string
  location: string
  project: string
  style: string
  memoryEntries: number
  skills: string[]
  tools: string[]
}

export interface Toast {
  id: string
  kind: 'info' | 'warn' | 'error'
  text: string
}

// ---- events main -> renderer --------------------------------------------------------------
export type AgentEvent =
  | { type: 'state'; state: AgentState }
  | { type: 'service'; status: ServiceStatus }
  | { type: 'message'; message: ChatMessage }
  | { type: 'partial'; text: string }
  | { type: 'level'; p: number }
  | { type: 'metrics'; turnId: string; metrics: TurnMetrics }
  | { type: 'duck'; gain: number }
  | { type: 'cue'; on: boolean }
  | { type: 'memory-confirm'; pending: PendingMemorySave | null }
  | { type: 'memory-changed' }
  | { type: 'sessions-changed' }
  | { type: 'settings-changed'; settings: Settings }
  | { type: 'toast'; toast: Toast }
  | { type: 'context'; snapshot: ContextSnapshot }
  | { type: 'skills-changed' }
  | { type: 'mcp-changed' }

export interface AudioChunk {
  turnId: string
  seq: number
  text: string
  mp3: ArrayBuffer
  last: boolean
}
